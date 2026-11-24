import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { decodeCursor, seekCondition, toPage, type CursorFields, type Page } from "./cursor-pagination.js";
import { DATABASE } from "./db.module.js";
import { isUniqueViolation } from "./pg-error.js";
import { SupplierLedgerService } from "./supplier-ledger.service.js";

export interface SupplierInvoiceItemRecord {
  id: string;
  purchaseOrderItemId: string;
  itemId: string;
  quantity: number;
  unitCostMinor: bigint;
  currency: string;
}

export interface SupplierInvoiceRecord {
  id: string;
  branchId: string;
  purchaseOrderId: string;
  supplierId: string;
  supplierInvoiceNumber: string;
  currency: string;
  totalMinor: bigint;
  recordedByUserId: string;
  items: SupplierInvoiceItemRecord[];
  createdAt: Date;
}

export interface SupplierInvoiceItemInput {
  purchaseOrderItemId: string;
  quantity: number;
  unitCostMinor: bigint;
}

export interface RecordSupplierInvoiceParams {
  restaurantId: string;
  actorUserId: string;
  purchaseOrderId: string;
  supplierInvoiceNumber: string;
  currency: string;
  totalMinor: bigint;
  items: SupplierInvoiceItemInput[];
}

export interface SupplierInvoiceMatchFlagRecord {
  id: string;
  branchId: string;
  supplierInvoiceId: string;
  supplierInvoiceItemId: string;
  purchaseOrderItemId: string;
  invoicedQuantity: number;
  orderedQuantity: number;
  receivedQuantity: number;
  invoicedUnitCostMinor: bigint;
  orderedUnitCostMinor: bigint;
  currency: string;
  mismatchedFields: string;
  reviewedAt: Date | null;
  reviewedByUserId: string | null;
  createdAt: Date;
}

export interface RecordSupplierInvoiceResult {
  invoice: SupplierInvoiceRecord;
  flags: SupplierInvoiceMatchFlagRecord[];
}

export interface ListSupplierInvoiceMatchFlagsParams {
  restaurantId: string;
  branchId?: string;
  reviewed?: boolean;
  cursor?: string;
  limit?: number;
}

export interface ReviewSupplierInvoiceMatchFlagParams {
  restaurantId: string;
  actorUserId: string;
  flagId: string;
}

const DEFAULT_LIST_LIMIT = 20;
const PO_NOT_FOUND = "Purchase order not found";
const PO_NOT_INVOICEABLE = "a supplier invoice can only be recorded once a purchase order has been sent";
const ITEMS_REQUIRED = "a supplier invoice must have at least one item";
const DUPLICATE_PO_ITEM = "each purchaseOrderItemId can only appear once per supplier invoice — combine quantities into a single line instead";
const PO_ITEM_NOT_FOUND = "one or more purchase order item ids don't belong to this purchase order";
const QUANTITY_MUST_BE_POSITIVE = "quantity must be positive";
const UNIT_COST_NON_NEGATIVE = "unitCostMinor must not be negative";
const TOTAL_NON_NEGATIVE = "totalMinor must not be negative";
const DUPLICATE_INVOICE_NUMBER = "a supplier invoice with this number has already been recorded for this supplier";
const FLAG_NOT_FOUND = "Supplier invoice match flag not found";
const ALREADY_REVIEWED = "this flag has already been reviewed";

/**
 * P3-23: supplier invoices — a real external document, append-only (rule
 * 4, UPDATE/DELETE revoked in app-role.ts) same as goods-received-notes.ts.
 * `record` is also the first real three-way match: for each line, it
 * compares what's being billed against what was ordered
 * (purchase_order_items.quantity/unitCostMinor, frozen once a PO leaves
 * draft) and what's actually arrived so far
 * (purchase_order_items.receivedQuantity, P3-22's own primitive) — any
 * mismatch produces a supplier_invoice_match_flags row (same "the document
 * itself is never touched, this is purely an additive diagnostic trail"
 * reasoning as ReconciliationService/P2-26), returned immediately alongside
 * the recorded invoice so a problem is visible the moment it's entered,
 * not only on a later review screen.
 *
 * Three checks per line: "quantity_exceeds_ordered" (billed for more than
 * was ever ordered), "quantity_exceeds_received" (billed for more than has
 * actually been confirmed received — the standard "don't pay for what
 * never arrived" check), and "price" (the invoice's own unitCostMinor
 * doesn't match what the PO line was frozen at). Deliberately does not
 * also compare against a goods-received-note's own invoicedUnitCostMinor
 * (P3-22) — that's a price captured at the delivery dock, a different
 * moment than the formal supplier invoice this task is about; the task
 * names exactly three documents (order, receipt, invoice), not four.
 */
@Injectable()
export class SupplierInvoicesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
    private readonly supplierLedgerService: SupplierLedgerService,
  ) {}

  async record(params: RecordSupplierInvoiceParams): Promise<RecordSupplierInvoiceResult> {
    if (params.items.length === 0) throw new BadRequestException(ITEMS_REQUIRED);
    if (new Set(params.items.map((item) => item.purchaseOrderItemId)).size !== params.items.length) throw new BadRequestException(DUPLICATE_PO_ITEM);
    if (params.totalMinor < 0n) throw new BadRequestException(TOTAL_NON_NEGATIVE);
    for (const item of params.items) {
      if (item.quantity <= 0) throw new BadRequestException(QUANTITY_MUST_BE_POSITIVE);
      if (item.unitCostMinor < 0n) throw new BadRequestException(UNIT_COST_NON_NEGATIVE);
    }

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const poRows = await tx.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, params.purchaseOrderId));
      const po = poRows[0];
      if (!po) throw new NotFoundException(PO_NOT_FOUND);
      if (po.status === "draft" || po.status === "approved") throw new BadRequestException(PO_NOT_INVOICEABLE);

      const poItemRows = await tx.select().from(schema.purchaseOrderItems).where(eq(schema.purchaseOrderItems.purchaseOrderId, po.id));
      const poItemsById = new Map(poItemRows.map((row) => [row.id, row]));
      for (const item of params.items) {
        if (!poItemsById.has(item.purchaseOrderItemId)) throw new BadRequestException(PO_ITEM_NOT_FOUND);
      }

      let invoiceRows: Array<typeof schema.supplierInvoices.$inferSelect>;
      try {
        invoiceRows = await tx
          .insert(schema.supplierInvoices)
          .values({
            restaurantId: params.restaurantId,
            branchId: po.branchId,
            purchaseOrderId: po.id,
            supplierId: po.supplierId,
            supplierInvoiceNumber: params.supplierInvoiceNumber,
            currency: params.currency,
            totalMinor: params.totalMinor,
            recordedByUserId: params.actorUserId,
          })
          .returning();
      } catch (error) {
        if (isUniqueViolation(error)) throw new BadRequestException(DUPLICATE_INVOICE_NUMBER);
        throw error;
      }
      const invoice = invoiceRows[0];
      if (!invoice) throw new Error("record: supplier invoice insert returned no row");

      // P3-25: every recorded supplier invoice is a real payable — unlike a
      // customer credit sale (an optional choice), this always happens, in
      // the same transaction as the invoice itself.
      await this.supplierLedgerService.recordInvoiceChargeInTx(tx, {
        restaurantId: params.restaurantId,
        branchId: po.branchId,
        supplierId: po.supplierId,
        actorUserId: params.actorUserId,
        amountMinor: invoice.totalMinor,
        currency: invoice.currency,
        supplierInvoiceId: invoice.id,
      });

      const items: SupplierInvoiceItemRecord[] = [];
      const flags: SupplierInvoiceMatchFlagRecord[] = [];

      for (const input of params.items) {
        const poItem = poItemsById.get(input.purchaseOrderItemId)!;

        const lineRows = await tx
          .insert(schema.supplierInvoiceItems)
          .values({
            restaurantId: params.restaurantId,
            supplierInvoiceId: invoice.id,
            purchaseOrderItemId: poItem.id,
            itemId: poItem.itemId,
            quantity: input.quantity,
            unitCostMinor: input.unitCostMinor,
            currency: params.currency,
          })
          .returning();
        const line = lineRows[0]!;
        items.push(line);

        const mismatched: string[] = [];
        if (input.quantity > poItem.quantity) mismatched.push("quantity_exceeds_ordered");
        if (input.quantity > poItem.receivedQuantity) mismatched.push("quantity_exceeds_received");
        if (input.unitCostMinor !== poItem.unitCostMinor) mismatched.push("price");

        if (mismatched.length > 0) {
          const flagRows = await tx
            .insert(schema.supplierInvoiceMatchFlags)
            .values({
              restaurantId: params.restaurantId,
              branchId: po.branchId,
              supplierInvoiceId: invoice.id,
              supplierInvoiceItemId: line.id,
              purchaseOrderItemId: poItem.id,
              invoicedQuantity: input.quantity,
              orderedQuantity: poItem.quantity,
              receivedQuantity: poItem.receivedQuantity,
              invoicedUnitCostMinor: input.unitCostMinor,
              orderedUnitCostMinor: poItem.unitCostMinor,
              currency: params.currency,
              mismatchedFields: mismatched.join(","),
            })
            .returning();
          flags.push(flagRows[0]!);
        }
      }

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          branchId: po.branchId,
          actorUserId: params.actorUserId,
          action: "supplier_invoice.recorded",
          targetType: "supplier_invoice",
          targetId: invoice.id,
          metadata: { purchaseOrderId: po.id, supplierInvoiceNumber: params.supplierInvoiceNumber, itemCount: items.length, flagCount: flags.length },
        },
        tx,
      );

      return { invoice: { ...invoice, items }, flags };
    });
  }

  async get(params: { restaurantId: string; supplierInvoiceId: string }): Promise<SupplierInvoiceRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx.select().from(schema.supplierInvoices).where(eq(schema.supplierInvoices.id, params.supplierInvoiceId));
      const invoice = rows[0];
      if (!invoice) throw new NotFoundException("Supplier invoice not found");
      const items = await tx.select().from(schema.supplierInvoiceItems).where(eq(schema.supplierInvoiceItems.supplierInvoiceId, invoice.id));
      return { ...invoice, items };
    });
  }

  async listForPurchaseOrder(params: { restaurantId: string; purchaseOrderId: string }): Promise<SupplierInvoiceRecord[]> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const invoices = await tx.select().from(schema.supplierInvoices).where(eq(schema.supplierInvoices.purchaseOrderId, params.purchaseOrderId));
      const results: SupplierInvoiceRecord[] = [];
      for (const invoice of invoices) {
        const items = await tx.select().from(schema.supplierInvoiceItems).where(eq(schema.supplierInvoiceItems.supplierInvoiceId, invoice.id));
        results.push({ ...invoice, items });
      }
      return results;
    });
  }

  async listFlags(params: ListSupplierInvoiceMatchFlagsParams): Promise<Page<SupplierInvoiceMatchFlagRecord>> {
    const limit = params.limit ?? DEFAULT_LIST_LIMIT;
    const after: CursorFields | undefined = params.cursor !== undefined ? decodeCursor(params.cursor) : undefined;
    const rows = await withTenant(this.db, { restaurantId: params.restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.supplierInvoiceMatchFlags)
        .where(
          and(
            params.branchId !== undefined ? eq(schema.supplierInvoiceMatchFlags.branchId, params.branchId) : undefined,
            params.reviewed === true
              ? isNotNull(schema.supplierInvoiceMatchFlags.reviewedAt)
              : params.reviewed === false
                ? isNull(schema.supplierInvoiceMatchFlags.reviewedAt)
                : undefined,
            seekCondition(schema.supplierInvoiceMatchFlags.createdAt, schema.supplierInvoiceMatchFlags.id, after),
          ),
        )
        .orderBy(desc(schema.supplierInvoiceMatchFlags.createdAt), desc(schema.supplierInvoiceMatchFlags.id))
        .limit(limit + 1),
    );
    return toPage(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  }

  async reviewFlag(params: ReviewSupplierInvoiceMatchFlagParams): Promise<SupplierInvoiceMatchFlagRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const existingRows = await tx.select().from(schema.supplierInvoiceMatchFlags).where(eq(schema.supplierInvoiceMatchFlags.id, params.flagId));
      const existing = existingRows[0];
      if (!existing) throw new NotFoundException(FLAG_NOT_FOUND);
      if (existing.reviewedAt !== null) throw new BadRequestException(ALREADY_REVIEWED);

      const rows = await tx
        .update(schema.supplierInvoiceMatchFlags)
        .set({ reviewedAt: new Date(), reviewedByUserId: params.actorUserId })
        .where(eq(schema.supplierInvoiceMatchFlags.id, params.flagId))
        .returning();
      const flag = rows[0];
      if (!flag) throw new Error("reviewFlag: update returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, branchId: flag.branchId, actorUserId: params.actorUserId, action: "supplier_invoice_match_flag.reviewed", targetType: "supplier_invoice_match_flag", targetId: flag.id },
        tx,
      );
      return flag;
    });
  }
}
