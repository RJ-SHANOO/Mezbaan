import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";
import { ManagerPinService } from "./manager-pin.service.js";
import { RecipesService } from "./recipes.service.js";
import { StockLedgerService } from "./stock-ledger.service.js";
import { expandLineIngredients, findDefaultSaleDeductionLocation } from "./stock-deduction-shared.js";

export type RefundStockDisposition = "return_to_stock" | "wastage";

export interface RefundReasonCodeRecord {
  id: string;
  code: string;
  label: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SetRefundReasonCodeParams {
  restaurantId: string;
  actorUserId: string;
  code: string;
  label: string;
  isActive?: boolean;
}

export interface RefundBalance {
  paidMinor: bigint;
  refundedMinor: bigint;
  refundableMinor: bigint;
}

export interface IssueRefundParams {
  restaurantId: string;
  actorUserId: string;
  invoiceId: string;
  amountMinor: bigint;
  reasonCode: string;
  managerUserId: string;
  managerPin: string;
  /** Which of the invoice's items this refund actually concerns — the
   * items whose recipe gets expanded for stockDisposition. Both optional
   * and given together: omit both for a bare amount-based refund (e.g. a
   * goodwill discretionary refund with no specific food item involved),
   * which has no stock effect at all. */
  itemIds?: string[];
  stockDisposition?: RefundStockDisposition;
}

export interface RefundRecord {
  id: string;
  invoiceId: string;
  amountMinor: bigint;
  currency: string;
  reasonCode: string;
  actorUserId: string;
  approvedByUserId: string;
  createdAt: Date;
}

const INVOICE_NOT_FOUND = "Invoice not found";
const AMOUNT_MUST_BE_POSITIVE = "amountMinor must be greater than zero";
const AMOUNT_EXCEEDS_REFUNDABLE = "amountMinor cannot exceed what's left to refund on this invoice";
const REASON_CODE_NOT_FOUND = "this refund reason code doesn't exist or is no longer active";
const ITEMS_AND_DISPOSITION_TOGETHER = "itemIds and stockDisposition must be given together, or not at all";
const ITEMS_NOT_FOUND = "one or more items don't belong to this invoice";

/** Plain JS/bigint sum, same reasoning as payments.service.ts's sumPaymentAmounts — the row count per invoice is always small. */
async function sumAmounts(rows: Array<{ amountMinor: bigint }>): Promise<bigint> {
  return rows.reduce((total, row) => total + row.amountMinor, 0n);
}

/**
 * P2-24: full and partial refunds, recorded as compensating rows against an
 * invoice (rule 4 — invoices/payments are append-only, never updated or
 * deleted; a refund is a new row, not a correction in place). Unlike
 * discounts (P2-22, own-authority limit) or voids (P2-23, only above
 * firedAt), a refund ALWAYS needs manager-PIN approval — reversing money
 * already recorded as collected is treated as the most sensitive change a
 * sale can undergo (rule 6), so there's no own-authority tier here at all.
 *
 * P3-18: unlike a void, a refunded item was already invoiced — P3-17
 * already deducted its ingredients via a "sale" movement by the time this
 * runs, so the stock choice here is the mirror image of VoidsService's:
 * "return_to_stock" records a new positive "return" movement (the goods
 * are physically intact and going back into inventory, reversing the
 * earlier sale deduction); "wastage" records nothing further — the
 * original sale deduction already correctly reflects that the ingredients
 * are gone, and recording a second deduction for the same consumption
 * would double-count it. Scoped to `itemIds` rather than the whole invoice
 * because a partial refund (rule: this service's own existing amount-based
 * balance check) doesn't necessarily correspond to specific items — a bare
 * amount-based refund with no itemIds has no stock effect at all.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
    private readonly managerPinService: ManagerPinService,
    private readonly recipesService: RecipesService,
    private readonly stockLedgerService: StockLedgerService,
  ) {}

  async listReasonCodes(restaurantId: string): Promise<RefundReasonCodeRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) => tx.select().from(schema.refundReasonCodes));
  }

  async setReasonCode(params: SetRefundReasonCodeParams): Promise<RefundReasonCodeRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .insert(schema.refundReasonCodes)
        .values({ restaurantId: params.restaurantId, code: params.code, label: params.label, isActive: params.isActive ?? true })
        .onConflictDoUpdate({
          target: [schema.refundReasonCodes.restaurantId, schema.refundReasonCodes.code],
          set: { label: params.label, isActive: params.isActive ?? true, updatedAt: new Date() },
        })
        .returning();
      const reasonCode = rows[0];
      if (!reasonCode) throw new Error("setReasonCode: upsert returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "refund_reason_code.set", targetType: "refund_reason_code", targetId: reasonCode.id, metadata: { code: params.code } },
        tx,
      );
      return reasonCode;
    });
  }

  async getBalance(params: { restaurantId: string; invoiceId: string }): Promise<RefundBalance> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const invoiceRows = await tx
        .select({ id: schema.invoices.id })
        .from(schema.invoices)
        .where(and(eq(schema.invoices.id, params.invoiceId), eq(schema.invoices.restaurantId, params.restaurantId)));
      if (!invoiceRows[0]) throw new NotFoundException(INVOICE_NOT_FOUND);
      return this.computeBalance(tx, params.invoiceId);
    });
  }

  async listForInvoice(params: { restaurantId: string; invoiceId: string }): Promise<RefundRecord[]> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, (tx) => tx.select().from(schema.refunds).where(eq(schema.refunds.invoiceId, params.invoiceId)));
  }

  async issue(params: IssueRefundParams): Promise<RefundRecord> {
    if (params.amountMinor <= 0n) throw new BadRequestException(AMOUNT_MUST_BE_POSITIVE);
    if ((params.itemIds !== undefined) !== (params.stockDisposition !== undefined)) throw new BadRequestException(ITEMS_AND_DISPOSITION_TOGETHER);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      // Row-locked so two concurrent refund attempts against the same invoice
      // can't both read the same "refundable" balance and both succeed — an
      // advisory lock, not SELECT ... FOR UPDATE, since rule 4 revokes UPDATE
      // on `invoices` at the database level (see PaymentsService.record,
      // P2-20, for why FOR UPDATE can't be used here).
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${params.invoiceId}))`);
      const invoiceRows = await tx
        .select()
        .from(schema.invoices)
        .where(and(eq(schema.invoices.id, params.invoiceId), eq(schema.invoices.restaurantId, params.restaurantId)));
      const invoice = invoiceRows[0];
      if (!invoice) throw new NotFoundException(INVOICE_NOT_FOUND);

      await this.requireActiveReasonCode(tx, params.reasonCode);

      const balance = await this.computeBalance(tx, params.invoiceId);
      if (params.amountMinor > balance.refundableMinor) throw new BadRequestException(AMOUNT_EXCEEDS_REFUNDABLE);

      await this.managerPinService.approve({
        restaurantId: params.restaurantId,
        branchId: invoice.branchId,
        managerUserId: params.managerUserId,
        pin: params.managerPin,
        requiredPermission: "billing.refund.approve",
        action: "invoice.refund",
      });

      const rows = await tx
        .insert(schema.refunds)
        .values({
          restaurantId: params.restaurantId,
          branchId: invoice.branchId,
          invoiceId: params.invoiceId,
          amountMinor: params.amountMinor,
          currency: invoice.currency,
          reasonCode: params.reasonCode,
          actorUserId: params.actorUserId,
          approvedByUserId: params.managerUserId,
        })
        .returning();
      const refund = rows[0];
      if (!refund) throw new Error("issue: refund insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "invoice.refunded",
          targetType: "refund",
          targetId: refund.id,
          metadata: {
            invoiceId: params.invoiceId,
            amountMinor: refund.amountMinor.toString(),
            reasonCode: params.reasonCode,
            approvedByUserId: params.managerUserId,
            itemIds: params.itemIds ?? null,
            stockDisposition: params.stockDisposition ?? null,
          },
        },
        tx,
      );

      if (params.itemIds && params.stockDisposition === "return_to_stock") {
        await this.returnItemsToStock(tx, params.restaurantId, params.actorUserId, invoice.branchId, params.invoiceId, params.itemIds, params.reasonCode);
      } else if (params.itemIds && params.stockDisposition === "wastage") {
        // The original sale already deducted these ingredients (P3-17) —
        // nothing further to record, see this service's own docs.
        await this.requireItemsBelongToInvoice(tx, params.invoiceId, params.itemIds);
      }

      return refund as RefundRecord;
    });
  }

  private async requireItemsBelongToInvoice(tx: Database, invoiceId: string, itemIds: string[]): Promise<Array<typeof schema.orderItems.$inferSelect>> {
    const items = await tx.select().from(schema.orderItems).where(inArray(schema.orderItems.id, itemIds));
    if (items.length !== itemIds.length || items.some((item) => item.invoiceId !== invoiceId)) throw new BadRequestException(ITEMS_NOT_FOUND);
    return items;
  }

  /** Reverses the refunded items' own (plus their modifiers') recipe —
   * one positive "return" movement per distinct ingredient — the mirror of
   * SalesStockDeductionService's "sale" deduction for the same items. */
  private async returnItemsToStock(tx: Database, restaurantId: string, actorUserId: string, branchId: string, invoiceId: string, itemIds: string[], refundReasonCode: string): Promise<void> {
    const items = await this.requireItemsBelongToInvoice(tx, invoiceId, itemIds);

    const defaultLocation = await findDefaultSaleDeductionLocation(tx, branchId);
    if (!defaultLocation) {
      this.logger.warn(`refund for invoice ${invoiceId}: branch ${branchId} has no sale-deduction default storage location configured — skipping stock return`);
      return;
    }

    const required = new Map<string, number>();
    const add = (itemId: string, quantity: number) => required.set(itemId, (required.get(itemId) ?? 0) + quantity);

    for (const item of items) {
      const modifierRows = await tx.select().from(schema.orderItemModifiers).where(eq(schema.orderItemModifiers.orderItemId, item.id));
      const { required: lineRequirements } = await expandLineIngredients(tx, this.recipesService, restaurantId, {
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
        modifiers: modifierRows.map((modifier) => ({ modifierOptionId: modifier.modifierOptionId, quantity: modifier.quantity })),
      });
      for (const [itemId, quantity] of lineRequirements) add(itemId, quantity);
    }

    for (const [itemId, quantity] of required) {
      if (quantity === 0) continue;
      await this.stockLedgerService.recordMovementInTx(tx, {
        restaurantId,
        actorUserId,
        storageLocationId: defaultLocation.id,
        itemId,
        movementType: "return",
        quantityDelta: quantity,
        note: `refund: ${refundReasonCode}`,
      });
    }
  }

  private async computeBalance(tx: Database, invoiceId: string): Promise<RefundBalance> {
    const paymentRows = await tx.select({ amountMinor: schema.payments.amountMinor }).from(schema.payments).where(eq(schema.payments.invoiceId, invoiceId));
    const refundRows = await tx.select({ amountMinor: schema.refunds.amountMinor }).from(schema.refunds).where(eq(schema.refunds.invoiceId, invoiceId));
    const paidMinor = await sumAmounts(paymentRows);
    const refundedMinor = await sumAmounts(refundRows);
    return { paidMinor, refundedMinor, refundableMinor: paidMinor - refundedMinor };
  }

  private async requireActiveReasonCode(tx: Database, code: string): Promise<void> {
    const rows = await tx.select({ isActive: schema.refundReasonCodes.isActive }).from(schema.refundReasonCodes).where(eq(schema.refundReasonCodes.code, code));
    if (!rows[0] || !rows[0].isActive) throw new BadRequestException(REASON_CODE_NOT_FOUND);
  }
}
