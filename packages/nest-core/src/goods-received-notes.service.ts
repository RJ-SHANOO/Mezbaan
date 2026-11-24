import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";
import { convertItemQuantityToBaseUnit } from "./item-quantity-conversion.js";
import { StockLedgerService } from "./stock-ledger.service.js";

export interface GoodsRejectionReasonCodeRecord {
  id: string;
  code: string;
  label: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SetGoodsRejectionReasonCodeParams {
  restaurantId: string;
  actorUserId: string;
  code: string;
  label: string;
  isActive?: boolean;
}

export interface GoodsReceivedNoteItemInput {
  purchaseOrderItemId: string;
  deliveredQuantity: number;
  rejectedQuantity?: number;
  rejectionReasonCode?: string;
  invoicedUnitCostMinor: bigint;
}

export interface RecordGoodsReceivedNoteParams {
  restaurantId: string;
  actorUserId: string;
  purchaseOrderId: string;
  storageLocationId: string;
  note?: string;
  items: GoodsReceivedNoteItemInput[];
}

export interface GoodsReceivedNoteItemRecord {
  id: string;
  purchaseOrderItemId: string;
  itemId: string;
  deliveredQuantity: number;
  rejectedQuantity: number;
  /** delivered - rejected, derived — never stored. */
  acceptedQuantity: number;
  rejectionReasonCode: string | null;
  invoicedUnitCostMinor: bigint;
  /** purchaseOrderItems.unitCostMinor at order time — re-derived from the
   * (immutable-once-approved) PO line, never duplicated into this table. */
  orderedUnitCostMinor: bigint;
  /** invoicedUnitCostMinor - orderedUnitCostMinor. Zero when the supplier
   * charged exactly what was ordered. */
  priceDifferenceMinor: bigint;
  currency: string;
  createdAt: Date;
}

export interface GoodsReceivedNoteRecord {
  id: string;
  branchId: string;
  purchaseOrderId: string;
  storageLocationId: string;
  receivedByUserId: string;
  note: string | null;
  items: GoodsReceivedNoteItemRecord[];
  createdAt: Date;
}

const PO_NOT_FOUND = "Purchase order not found";
const PO_NOT_RECEIVABLE = "goods can only be received against a purchase order that's been sent (or already partly received)";
const LOCATION_NOT_FOUND = "Storage location not found";
const LOCATION_WRONG_BRANCH = "this storage location doesn't belong to the purchase order's own branch";
const ITEMS_REQUIRED = "a goods received note must have at least one item";
const PO_ITEM_NOT_FOUND = "one or more purchase order item ids don't belong to this purchase order";
const REASON_CODE_REQUIRED = "rejectionReasonCode is required whenever rejectedQuantity is greater than zero";
const REASON_CODE_NOT_FOUND = "this rejection reason code doesn't exist or is no longer active";
const DELIVERED_MUST_BE_POSITIVE = "deliveredQuantity must be greater than zero";
const REJECTED_EXCEEDS_DELIVERED = "rejectedQuantity cannot exceed deliveredQuantity";
const INVOICED_COST_NON_NEGATIVE = "invoicedUnitCostMinor must not be negative";
const DUPLICATE_PO_ITEM = "each purchaseOrderItemId can only appear once per goods received note — combine quantities into a single line instead";

/**
 * P3-22: the first real consumer of stock_ledger's "purchase" movement
 * type (P3-09 built the enum value with no caller until now) and of
 * purchase_order_items.receivedQuantity (P3-21's own primitive). Append-
 * only (rule 4, UPDATE/DELETE revoked in app-role.ts) — documents a
 * delivery that already happened.
 *
 * Partial delivery is just "call this again" — a purchase order can have
 * any number of these over time, and each one's accepted quantity (never
 * stored, always delivered-minus-rejected) adds onto
 * purchase_order_items.receivedQuantity. After applying one note, the
 * order's own status is recomputed from scratch by comparing every
 * line's cumulative receivedQuantity against what was ordered: closed
 * once every line is fully received, partly_received if any line has
 * received something but not everything, otherwise left alone (stays
 * "sent" — recording a note always receives something, so this branch is
 * only reachable by a quantity of exactly zero, which `deliveredQuantity
 * > 0` already rules out).
 *
 * Price differences: `invoicedUnitCostMinor` is what the supplier
 * actually charged on this delivery, independent of
 * purchase_order_items.unitCostMinor (what was ordered at, frozen once a
 * PO leaves draft) — the gap between the two is reported back
 * (priceDifferenceMinor) but never written anywhere a second time, and is
 * exactly what StockLedgerService values the resulting "purchase"
 * increase at (rule 3/11: stock is costed at what was actually paid).
 * Deliberately does NOT also append a supplier_item_prices row — that's a
 * separate, explicit action (POST /supplier-item-prices) an admin takes
 * if they want this delivery's price to become the new standing quote;
 * coupling the two would mean a missing supplier/item link (P3-20) could
 * block recording a delivery that has already physically happened, which
 * rule 14 doesn't allow.
 */
@Injectable()
export class GoodsReceivedNotesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
    private readonly stockLedgerService: StockLedgerService,
  ) {}

  async listReasonCodes(restaurantId: string): Promise<GoodsRejectionReasonCodeRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) => tx.select().from(schema.goodsRejectionReasonCodes));
  }

  async setReasonCode(params: SetGoodsRejectionReasonCodeParams): Promise<GoodsRejectionReasonCodeRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .insert(schema.goodsRejectionReasonCodes)
        .values({ restaurantId: params.restaurantId, code: params.code, label: params.label, isActive: params.isActive ?? true })
        .onConflictDoUpdate({
          target: [schema.goodsRejectionReasonCodes.restaurantId, schema.goodsRejectionReasonCodes.code],
          set: { label: params.label, isActive: params.isActive ?? true, updatedAt: new Date() },
        })
        .returning();
      const reasonCode = rows[0];
      if (!reasonCode) throw new Error("setReasonCode: upsert returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "goods_rejection_reason_code.set", targetType: "goods_rejection_reason_code", targetId: reasonCode.id, metadata: { code: params.code } },
        tx,
      );
      return reasonCode;
    });
  }

  async record(params: RecordGoodsReceivedNoteParams): Promise<GoodsReceivedNoteRecord> {
    if (params.items.length === 0) throw new BadRequestException(ITEMS_REQUIRED);
    if (new Set(params.items.map((item) => item.purchaseOrderItemId)).size !== params.items.length) throw new BadRequestException(DUPLICATE_PO_ITEM);
    for (const item of params.items) {
      if (item.deliveredQuantity <= 0) throw new BadRequestException(DELIVERED_MUST_BE_POSITIVE);
      if ((item.rejectedQuantity ?? 0) > item.deliveredQuantity) throw new BadRequestException(REJECTED_EXCEEDS_DELIVERED);
      if ((item.rejectedQuantity ?? 0) > 0 && !item.rejectionReasonCode) throw new BadRequestException(REASON_CODE_REQUIRED);
      if (item.invoicedUnitCostMinor < 0n) throw new BadRequestException(INVOICED_COST_NON_NEGATIVE);
    }

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const poRows = await tx.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, params.purchaseOrderId));
      const po = poRows[0];
      if (!po) throw new NotFoundException(PO_NOT_FOUND);
      if (po.status !== "sent" && po.status !== "partly_received") throw new BadRequestException(PO_NOT_RECEIVABLE);

      const locationRows = await tx.select({ branchId: schema.storageLocations.branchId }).from(schema.storageLocations).where(eq(schema.storageLocations.id, params.storageLocationId));
      const location = locationRows[0];
      if (!location) throw new NotFoundException(LOCATION_NOT_FOUND);
      if (location.branchId !== po.branchId) throw new BadRequestException(LOCATION_WRONG_BRANCH);

      const poItemRows = await tx.select().from(schema.purchaseOrderItems).where(eq(schema.purchaseOrderItems.purchaseOrderId, po.id));
      const poItemsById = new Map(poItemRows.map((row) => [row.id, row]));
      for (const item of params.items) {
        if (!poItemsById.has(item.purchaseOrderItemId)) throw new BadRequestException(PO_ITEM_NOT_FOUND);
      }

      const reasonCodes = new Set(
        (await tx.select({ code: schema.goodsRejectionReasonCodes.code }).from(schema.goodsRejectionReasonCodes).where(eq(schema.goodsRejectionReasonCodes.isActive, true))).map((row) => row.code),
      );
      for (const item of params.items) {
        if (item.rejectionReasonCode && !reasonCodes.has(item.rejectionReasonCode)) throw new BadRequestException(REASON_CODE_NOT_FOUND);
      }

      const noteRows = await tx
        .insert(schema.goodsReceivedNotes)
        .values({
          restaurantId: params.restaurantId,
          branchId: po.branchId,
          purchaseOrderId: po.id,
          storageLocationId: params.storageLocationId,
          receivedByUserId: params.actorUserId,
          note: params.note ?? null,
        })
        .returning();
      const note = noteRows[0];
      if (!note) throw new Error("record: goods received note insert returned no row");

      const items: GoodsReceivedNoteItemRecord[] = [];
      for (const input of params.items) {
        const poItem = poItemsById.get(input.purchaseOrderItemId)!;
        const rejectedQuantity = input.rejectedQuantity ?? 0;
        const acceptedQuantity = input.deliveredQuantity - rejectedQuantity;

        const lineRows = await tx
          .insert(schema.goodsReceivedNoteItems)
          .values({
            restaurantId: params.restaurantId,
            goodsReceivedNoteId: note.id,
            purchaseOrderItemId: poItem.id,
            itemId: poItem.itemId,
            deliveredQuantity: input.deliveredQuantity,
            rejectedQuantity,
            rejectionReasonCode: input.rejectionReasonCode ?? null,
            invoicedUnitCostMinor: input.invoicedUnitCostMinor,
            currency: poItem.currency,
          })
          .returning();
        const line = lineRows[0]!;

        await tx
          .update(schema.purchaseOrderItems)
          .set({ receivedQuantity: poItem.receivedQuantity + acceptedQuantity, updatedAt: new Date() })
          .where(eq(schema.purchaseOrderItems.id, poItem.id));

        if (acceptedQuantity > 0) {
          const acceptedInBaseUnit = await convertItemQuantityToBaseUnit(tx, poItem.itemId, acceptedQuantity, poItem.unitId);
          await this.stockLedgerService.recordMovementInTx(tx, {
            restaurantId: params.restaurantId,
            actorUserId: params.actorUserId,
            storageLocationId: params.storageLocationId,
            itemId: poItem.itemId,
            movementType: "purchase",
            quantityDelta: acceptedInBaseUnit,
            unitCostMinor: input.invoicedUnitCostMinor,
            currency: poItem.currency,
            note: `goods received note ${note.id}`,
          });
        }

        items.push({
          id: line.id,
          purchaseOrderItemId: line.purchaseOrderItemId,
          itemId: line.itemId,
          deliveredQuantity: line.deliveredQuantity,
          rejectedQuantity: line.rejectedQuantity,
          acceptedQuantity,
          rejectionReasonCode: line.rejectionReasonCode,
          invoicedUnitCostMinor: line.invoicedUnitCostMinor,
          orderedUnitCostMinor: poItem.unitCostMinor,
          priceDifferenceMinor: line.invoicedUnitCostMinor - poItem.unitCostMinor,
          currency: line.currency,
          createdAt: line.createdAt,
        });
      }

      await this.recomputeStatus(tx, params.restaurantId, po.id, po.branchId, params.actorUserId);

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          branchId: po.branchId,
          actorUserId: params.actorUserId,
          action: "goods_received_note.recorded",
          targetType: "goods_received_note",
          targetId: note.id,
          metadata: { purchaseOrderId: po.id, itemCount: items.length },
        },
        tx,
      );

      return { ...note, items };
    });
  }

  async get(params: { restaurantId: string; goodsReceivedNoteId: string }): Promise<GoodsReceivedNoteRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const noteRows = await tx.select().from(schema.goodsReceivedNotes).where(eq(schema.goodsReceivedNotes.id, params.goodsReceivedNoteId));
      const note = noteRows[0];
      if (!note) throw new NotFoundException("Goods received note not found");
      return this.buildRecord(tx, note);
    });
  }

  async listForPurchaseOrder(params: { restaurantId: string; purchaseOrderId: string }): Promise<GoodsReceivedNoteRecord[]> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const notes = await tx.select().from(schema.goodsReceivedNotes).where(eq(schema.goodsReceivedNotes.purchaseOrderId, params.purchaseOrderId));
      const results: GoodsReceivedNoteRecord[] = [];
      for (const note of notes) {
        results.push(await this.buildRecord(tx, note));
      }
      return results;
    });
  }

  /** Shared by get()/listForPurchaseOrder() so both run against the
   * caller's own already-open `tx` instead of each opening a separate
   * withTenant transaction (and, for listForPurchaseOrder, a separate one
   * per note). */
  private async buildRecord(tx: Database, note: typeof schema.goodsReceivedNotes.$inferSelect): Promise<GoodsReceivedNoteRecord> {
    const lineRows = await tx.select().from(schema.goodsReceivedNoteItems).where(eq(schema.goodsReceivedNoteItems.goodsReceivedNoteId, note.id));
    const poItemRows = lineRows.length > 0 ? await tx.select().from(schema.purchaseOrderItems).where(eq(schema.purchaseOrderItems.purchaseOrderId, note.purchaseOrderId)) : [];
    const poItemsById = new Map(poItemRows.map((row) => [row.id, row]));

    const items: GoodsReceivedNoteItemRecord[] = lineRows.map((line) => {
      const poItem = poItemsById.get(line.purchaseOrderItemId);
      return {
        id: line.id,
        purchaseOrderItemId: line.purchaseOrderItemId,
        itemId: line.itemId,
        deliveredQuantity: line.deliveredQuantity,
        rejectedQuantity: line.rejectedQuantity,
        acceptedQuantity: line.deliveredQuantity - line.rejectedQuantity,
        rejectionReasonCode: line.rejectionReasonCode,
        invoicedUnitCostMinor: line.invoicedUnitCostMinor,
        orderedUnitCostMinor: poItem?.unitCostMinor ?? 0n,
        priceDifferenceMinor: line.invoicedUnitCostMinor - (poItem?.unitCostMinor ?? 0n),
        currency: line.currency,
        createdAt: line.createdAt,
      };
    });
    return { ...note, items };
  }

  /** Every line's cumulative receivedQuantity vs. what was ordered decides
   * the order's own status — closed once nothing is left outstanding on
   * any line, partly_received if some but not all has arrived. */
  private async recomputeStatus(tx: Database, restaurantId: string, purchaseOrderId: string, branchId: string, actorUserId: string): Promise<void> {
    const items = await tx.select().from(schema.purchaseOrderItems).where(eq(schema.purchaseOrderItems.purchaseOrderId, purchaseOrderId));
    const allFullyReceived = items.every((item) => item.receivedQuantity >= item.quantity);
    const anyReceived = items.some((item) => item.receivedQuantity > 0);

    const newStatus = allFullyReceived ? "closed" : anyReceived ? "partly_received" : undefined;
    if (!newStatus) return;

    await tx
      .update(schema.purchaseOrders)
      .set({ status: newStatus, closedAt: newStatus === "closed" ? new Date() : undefined, updatedAt: new Date() })
      .where(eq(schema.purchaseOrders.id, purchaseOrderId));

    await this.auditLogService.record(
      { restaurantId, branchId, actorUserId, action: "purchase_order.status_recomputed", targetType: "purchase_order", targetId: purchaseOrderId, metadata: { status: newStatus } },
      tx,
    );
  }
}
