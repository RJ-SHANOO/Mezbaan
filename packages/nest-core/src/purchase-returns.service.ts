import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";
import { convertItemQuantityToBaseUnit } from "./item-quantity-conversion.js";
import { StockLedgerService } from "./stock-ledger.service.js";

export interface PurchaseReturnReasonCodeRecord {
  id: string;
  code: string;
  label: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SetPurchaseReturnReasonCodeParams {
  restaurantId: string;
  actorUserId: string;
  code: string;
  label: string;
  isActive?: boolean;
}

export interface PurchaseReturnItemInput {
  purchaseOrderItemId: string;
  quantity: number;
  reasonCode: string;
}

export interface RecordPurchaseReturnParams {
  restaurantId: string;
  actorUserId: string;
  purchaseOrderId: string;
  storageLocationId: string;
  note?: string;
  items: PurchaseReturnItemInput[];
}

export interface PurchaseReturnItemRecord {
  id: string;
  purchaseOrderItemId: string;
  itemId: string;
  quantity: number;
  reasonCode: string;
  createdAt: Date;
}

export interface PurchaseReturnRecord {
  id: string;
  branchId: string;
  purchaseOrderId: string;
  storageLocationId: string;
  returnedByUserId: string;
  note: string | null;
  items: PurchaseReturnItemRecord[];
  createdAt: Date;
}

const PO_NOT_FOUND = "Purchase order not found";
const PO_NOT_RETURNABLE = "stock can only be returned against a purchase order that's had something received against it";
const LOCATION_NOT_FOUND = "Storage location not found";
const LOCATION_WRONG_BRANCH = "this storage location doesn't belong to the purchase order's own branch";
const ITEMS_REQUIRED = "a purchase return must have at least one item";
const DUPLICATE_PO_ITEM = "each purchaseOrderItemId can only appear once per purchase return — combine quantities into a single line instead";
const PO_ITEM_NOT_FOUND = "one or more purchase order item ids don't belong to this purchase order";
const QUANTITY_MUST_BE_POSITIVE = "quantity must be positive";
const REASON_CODE_NOT_FOUND = "this purchase return reason code doesn't exist or is no longer active";
const QUANTITY_EXCEEDS_AVAILABLE = "quantity exceeds what's still held from this line (receivedQuantity minus already-returned quantity)";

/**
 * P3-24: "purchase returns through compensating stock movements" — the
 * first real caller to decrease stock via stock_ledger's "return"
 * movement type (P3-18's refunds used the same type for the opposite,
 * positive direction; see stock-ledger.ts's own "signed, not type-implied
 * direction" reasoning for why one enum value covers both). Append-only
 * (rule 4, UPDATE/DELETE revoked in app-role.ts) — a real event, same as
 * goods-received-notes.ts.
 *
 * Validated against purchase_order_items.receivedQuantity minus its own
 * returnedQuantity (P3-22/this task's own column) — what's actually still
 * held from that line — not against the original ordered `quantity`,
 * since a line can be partially received and partially returned
 * independently of how much was ever ordered. No ManagerPinService
 * approval gate here, unlike P2-22/23/24's discount/void/refund flows —
 * this task doesn't name one, and the one explicit approval moment in
 * this whole purchasing chain is P3-21's own PO approval step.
 */
@Injectable()
export class PurchaseReturnsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
    private readonly stockLedgerService: StockLedgerService,
  ) {}

  async listReasonCodes(restaurantId: string): Promise<PurchaseReturnReasonCodeRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) => tx.select().from(schema.purchaseReturnReasonCodes));
  }

  async setReasonCode(params: SetPurchaseReturnReasonCodeParams): Promise<PurchaseReturnReasonCodeRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .insert(schema.purchaseReturnReasonCodes)
        .values({ restaurantId: params.restaurantId, code: params.code, label: params.label, isActive: params.isActive ?? true })
        .onConflictDoUpdate({
          target: [schema.purchaseReturnReasonCodes.restaurantId, schema.purchaseReturnReasonCodes.code],
          set: { label: params.label, isActive: params.isActive ?? true, updatedAt: new Date() },
        })
        .returning();
      const reasonCode = rows[0];
      if (!reasonCode) throw new Error("setReasonCode: upsert returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "purchase_return_reason_code.set", targetType: "purchase_return_reason_code", targetId: reasonCode.id, metadata: { code: params.code } },
        tx,
      );
      return reasonCode;
    });
  }

  async record(params: RecordPurchaseReturnParams): Promise<PurchaseReturnRecord> {
    if (params.items.length === 0) throw new BadRequestException(ITEMS_REQUIRED);
    if (new Set(params.items.map((item) => item.purchaseOrderItemId)).size !== params.items.length) throw new BadRequestException(DUPLICATE_PO_ITEM);
    for (const item of params.items) {
      if (item.quantity <= 0) throw new BadRequestException(QUANTITY_MUST_BE_POSITIVE);
    }

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const poRows = await tx.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, params.purchaseOrderId));
      const po = poRows[0];
      if (!po) throw new NotFoundException(PO_NOT_FOUND);
      if (po.status !== "partly_received" && po.status !== "closed") throw new BadRequestException(PO_NOT_RETURNABLE);

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
        (await tx.select({ code: schema.purchaseReturnReasonCodes.code }).from(schema.purchaseReturnReasonCodes).where(eq(schema.purchaseReturnReasonCodes.isActive, true))).map((row) => row.code),
      );
      for (const item of params.items) {
        if (!reasonCodes.has(item.reasonCode)) throw new BadRequestException(REASON_CODE_NOT_FOUND);
      }

      for (const item of params.items) {
        const poItem = poItemsById.get(item.purchaseOrderItemId)!;
        const available = poItem.receivedQuantity - poItem.returnedQuantity;
        if (item.quantity > available) throw new BadRequestException(QUANTITY_EXCEEDS_AVAILABLE);
      }

      const returnRows = await tx
        .insert(schema.purchaseReturns)
        .values({
          restaurantId: params.restaurantId,
          branchId: po.branchId,
          purchaseOrderId: po.id,
          storageLocationId: params.storageLocationId,
          returnedByUserId: params.actorUserId,
          note: params.note ?? null,
        })
        .returning();
      const purchaseReturn = returnRows[0];
      if (!purchaseReturn) throw new Error("record: purchase return insert returned no row");

      const items: PurchaseReturnItemRecord[] = [];
      for (const input of params.items) {
        const poItem = poItemsById.get(input.purchaseOrderItemId)!;

        const lineRows = await tx
          .insert(schema.purchaseReturnItems)
          .values({
            restaurantId: params.restaurantId,
            purchaseReturnId: purchaseReturn.id,
            purchaseOrderItemId: poItem.id,
            itemId: poItem.itemId,
            quantity: input.quantity,
            reasonCode: input.reasonCode,
          })
          .returning();
        items.push(lineRows[0]!);

        await tx
          .update(schema.purchaseOrderItems)
          .set({ returnedQuantity: poItem.returnedQuantity + input.quantity, updatedAt: new Date() })
          .where(eq(schema.purchaseOrderItems.id, poItem.id));

        const quantityInBaseUnit = await convertItemQuantityToBaseUnit(tx, poItem.itemId, input.quantity, poItem.unitId);
        await this.stockLedgerService.recordMovementInTx(tx, {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          storageLocationId: params.storageLocationId,
          itemId: poItem.itemId,
          movementType: "return",
          quantityDelta: -quantityInBaseUnit,
          note: `purchase return ${purchaseReturn.id}: ${input.reasonCode}`,
        });
      }

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          branchId: po.branchId,
          actorUserId: params.actorUserId,
          action: "purchase_return.recorded",
          targetType: "purchase_return",
          targetId: purchaseReturn.id,
          metadata: { purchaseOrderId: po.id, itemCount: items.length },
        },
        tx,
      );

      return { ...purchaseReturn, items };
    });
  }

  async get(params: { restaurantId: string; purchaseReturnId: string }): Promise<PurchaseReturnRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx.select().from(schema.purchaseReturns).where(eq(schema.purchaseReturns.id, params.purchaseReturnId));
      const purchaseReturn = rows[0];
      if (!purchaseReturn) throw new NotFoundException("Purchase return not found");
      const items = await tx.select().from(schema.purchaseReturnItems).where(eq(schema.purchaseReturnItems.purchaseReturnId, purchaseReturn.id));
      return { ...purchaseReturn, items };
    });
  }

  async listForPurchaseOrder(params: { restaurantId: string; purchaseOrderId: string }): Promise<PurchaseReturnRecord[]> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const returns = await tx.select().from(schema.purchaseReturns).where(eq(schema.purchaseReturns.purchaseOrderId, params.purchaseOrderId));
      const results: PurchaseReturnRecord[] = [];
      for (const purchaseReturn of returns) {
        const items = await tx.select().from(schema.purchaseReturnItems).where(eq(schema.purchaseReturnItems.purchaseReturnId, purchaseReturn.id));
        results.push({ ...purchaseReturn, items });
      }
      return results;
    });
  }
}
