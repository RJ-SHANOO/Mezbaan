import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";
import { ManagerPinService } from "./manager-pin.service.js";

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
 */
@Injectable()
export class RefundsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
    private readonly managerPinService: ManagerPinService,
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
      const invoiceRows = await tx.select({ id: schema.invoices.id }).from(schema.invoices).where(eq(schema.invoices.id, params.invoiceId));
      if (!invoiceRows[0]) throw new NotFoundException(INVOICE_NOT_FOUND);
      return this.computeBalance(tx, params.invoiceId);
    });
  }

  async listForInvoice(params: { restaurantId: string; invoiceId: string }): Promise<RefundRecord[]> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, (tx) => tx.select().from(schema.refunds).where(eq(schema.refunds.invoiceId, params.invoiceId)));
  }

  async issue(params: IssueRefundParams): Promise<RefundRecord> {
    if (params.amountMinor <= 0n) throw new BadRequestException(AMOUNT_MUST_BE_POSITIVE);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      // Row-locked so two concurrent refund attempts against the same invoice
      // can't both read the same "refundable" balance and both succeed — an
      // advisory lock, not SELECT ... FOR UPDATE, since rule 4 revokes UPDATE
      // on `invoices` at the database level (see PaymentsService.record,
      // P2-20, for why FOR UPDATE can't be used here).
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${params.invoiceId}))`);
      const invoiceRows = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, params.invoiceId));
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
          metadata: { invoiceId: params.invoiceId, amountMinor: refund.amountMinor.toString(), reasonCode: params.reasonCode, approvedByUserId: params.managerUserId },
        },
        tx,
      );

      return refund as RefundRecord;
    });
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
