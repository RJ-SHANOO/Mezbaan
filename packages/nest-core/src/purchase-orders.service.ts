import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { decodeCursor, seekCondition, toPage, type CursorFields, type Page } from "./cursor-pagination.js";
import { DATABASE } from "./db.module.js";
import { ManagerPinService } from "./manager-pin.service.js";

export type PurchaseOrderStatus = "draft" | "approved" | "sent" | "partly_received" | "closed";

export interface PurchaseOrderItemRecord {
  id: string;
  itemId: string;
  quantity: number;
  unitId: string;
  unitCostMinor: bigint;
  currency: string;
  receivedQuantity: number;
}

export interface PurchaseOrderRecord {
  id: string;
  branchId: string;
  supplierId: string;
  status: PurchaseOrderStatus;
  currency: string;
  note: string | null;
  createdByUserId: string;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  sentAt: Date | null;
  closedAt: Date | null;
  items: PurchaseOrderItemRecord[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PurchaseOrderItemInput {
  itemId: string;
  quantity: number;
  unitId: string;
  unitCostMinor: bigint;
}

export interface CreatePurchaseOrderParams {
  restaurantId: string;
  actorUserId: string;
  branchId: string;
  supplierId: string;
  currency: string;
  note?: string;
  items: PurchaseOrderItemInput[];
}

export interface ReplacePurchaseOrderItemsParams {
  restaurantId: string;
  actorUserId: string;
  purchaseOrderId: string;
  items: PurchaseOrderItemInput[];
}

export interface ApprovePurchaseOrderParams {
  restaurantId: string;
  actorUserId: string;
  purchaseOrderId: string;
  managerUserId: string;
  managerPin: string;
}

export interface MarkPurchaseOrderSentParams {
  restaurantId: string;
  actorUserId: string;
  purchaseOrderId: string;
}

export interface ListPurchaseOrdersParams {
  restaurantId: string;
  branchId?: string;
  supplierId?: string;
  status?: PurchaseOrderStatus;
  cursor?: string;
  limit?: number;
}

const DEFAULT_LIST_LIMIT = 20;
const PO_NOT_FOUND = "Purchase order not found";
const BRANCH_NOT_FOUND = "Branch not found";
const SUPPLIER_NOT_FOUND = "Supplier not found";
const UNIT_NOT_FOUND = "Unit not found";
const ITEM_NOT_FOUND = "Inventory item not found";
const ITEMS_REQUIRED = "a purchase order must have at least one item";
const NOT_DRAFT = "a purchase order's items can only be edited while it's still a draft";
const NOT_DRAFT_FOR_APPROVAL = "only a draft purchase order can be approved";
const NOT_APPROVED_FOR_SENDING = "only an approved purchase order can be marked sent";

/**
 * P3-21: a branch's order placed with a supplier — see purchase-orders.ts's
 * own docs for the full status lifecycle and why "approved" needs
 * ManagerPinService (same established pattern as DiscountsService/
 * VoidsService/RefundsService) while "sent" doesn't — approval is the
 * money-committing decision; marking something already-approved as sent is
 * just recording a fact about what happened next.
 */
@Injectable()
export class PurchaseOrdersService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
    private readonly managerPinService: ManagerPinService,
  ) {}

  async create(params: CreatePurchaseOrderParams): Promise<PurchaseOrderRecord> {
    if (params.items.length === 0) throw new BadRequestException(ITEMS_REQUIRED);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const branchRows = await tx.select({ id: schema.branches.id }).from(schema.branches).where(eq(schema.branches.id, params.branchId));
      if (branchRows.length === 0) throw new NotFoundException(BRANCH_NOT_FOUND);

      const supplierRows = await tx.select({ id: schema.suppliers.id }).from(schema.suppliers).where(eq(schema.suppliers.id, params.supplierId));
      if (supplierRows.length === 0) throw new NotFoundException(SUPPLIER_NOT_FOUND);

      await this.requireValidItems(tx, params.items);

      const poRows = await tx
        .insert(schema.purchaseOrders)
        .values({
          restaurantId: params.restaurantId,
          branchId: params.branchId,
          supplierId: params.supplierId,
          currency: params.currency,
          note: params.note ?? null,
          createdByUserId: params.actorUserId,
        })
        .returning();
      const po = poRows[0];
      if (!po) throw new Error("create: purchase order insert returned no row");

      const items = await this.insertItems(tx, params.restaurantId, po.id, params.currency, params.items);

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, branchId: params.branchId, actorUserId: params.actorUserId, action: "purchase_order.created", targetType: "purchase_order", targetId: po.id, metadata: { supplierId: params.supplierId, itemCount: items.length } },
        tx,
      );
      return { ...po, items };
    });
  }

  async replaceItems(params: ReplacePurchaseOrderItemsParams): Promise<PurchaseOrderRecord> {
    if (params.items.length === 0) throw new BadRequestException(ITEMS_REQUIRED);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const po = await this.requirePurchaseOrder(tx, params.purchaseOrderId);
      if (po.status !== "draft") throw new BadRequestException(NOT_DRAFT);

      await this.requireValidItems(tx, params.items);

      await tx.delete(schema.purchaseOrderItems).where(eq(schema.purchaseOrderItems.purchaseOrderId, po.id));
      const items = await this.insertItems(tx, params.restaurantId, po.id, po.currency, params.items);

      const updatedRows = await tx.update(schema.purchaseOrders).set({ updatedAt: new Date() }).where(eq(schema.purchaseOrders.id, po.id)).returning();
      const updated = updatedRows[0]!;

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, branchId: po.branchId, actorUserId: params.actorUserId, action: "purchase_order.items_replaced", targetType: "purchase_order", targetId: po.id, metadata: { itemCount: items.length } },
        tx,
      );
      return { ...updated, items };
    });
  }

  async approve(params: ApprovePurchaseOrderParams): Promise<PurchaseOrderRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const po = await this.requirePurchaseOrder(tx, params.purchaseOrderId);
      if (po.status !== "draft") throw new BadRequestException(NOT_DRAFT_FOR_APPROVAL);

      await this.managerPinService.approve({
        restaurantId: params.restaurantId,
        branchId: po.branchId,
        managerUserId: params.managerUserId,
        pin: params.managerPin,
        requiredPermission: "purchasing.po.approve",
        action: "purchase_order.approve",
      });

      const rows = await tx
        .update(schema.purchaseOrders)
        .set({ status: "approved", approvedByUserId: params.managerUserId, approvedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.purchaseOrders.id, po.id))
        .returning();
      const updated = rows[0]!;

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, branchId: po.branchId, actorUserId: params.actorUserId, action: "purchase_order.approved", targetType: "purchase_order", targetId: po.id, metadata: { approvedByUserId: params.managerUserId } },
        tx,
      );
      return { ...updated, items: await this.listItems(tx, po.id) };
    });
  }

  async markSent(params: MarkPurchaseOrderSentParams): Promise<PurchaseOrderRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const po = await this.requirePurchaseOrder(tx, params.purchaseOrderId);
      if (po.status !== "approved") throw new BadRequestException(NOT_APPROVED_FOR_SENDING);

      const rows = await tx
        .update(schema.purchaseOrders)
        .set({ status: "sent", sentAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.purchaseOrders.id, po.id))
        .returning();
      const updated = rows[0]!;

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, branchId: po.branchId, actorUserId: params.actorUserId, action: "purchase_order.sent", targetType: "purchase_order", targetId: po.id },
        tx,
      );
      return { ...updated, items: await this.listItems(tx, po.id) };
    });
  }

  async get(params: { restaurantId: string; purchaseOrderId: string }): Promise<PurchaseOrderRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const po = await this.requirePurchaseOrder(tx, params.purchaseOrderId);
      return { ...po, items: await this.listItems(tx, po.id) };
    });
  }

  async list(params: ListPurchaseOrdersParams): Promise<Page<Omit<PurchaseOrderRecord, "items">>> {
    const limit = params.limit ?? DEFAULT_LIST_LIMIT;
    const after: CursorFields | undefined = params.cursor !== undefined ? decodeCursor(params.cursor) : undefined;
    const rows = await withTenant(this.db, { restaurantId: params.restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.purchaseOrders)
        .where(
          and(
            params.branchId !== undefined ? eq(schema.purchaseOrders.branchId, params.branchId) : undefined,
            params.supplierId !== undefined ? eq(schema.purchaseOrders.supplierId, params.supplierId) : undefined,
            params.status !== undefined ? eq(schema.purchaseOrders.status, params.status) : undefined,
            seekCondition(schema.purchaseOrders.createdAt, schema.purchaseOrders.id, after),
          ),
        )
        .orderBy(desc(schema.purchaseOrders.createdAt), desc(schema.purchaseOrders.id))
        .limit(limit + 1),
    );
    return toPage(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  }

  private async requirePurchaseOrder(tx: Database, purchaseOrderId: string): Promise<typeof schema.purchaseOrders.$inferSelect> {
    const rows = await tx.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, purchaseOrderId));
    const po = rows[0];
    if (!po) throw new NotFoundException(PO_NOT_FOUND);
    return po;
  }

  private async listItems(tx: Database, purchaseOrderId: string): Promise<PurchaseOrderItemRecord[]> {
    return tx.select().from(schema.purchaseOrderItems).where(eq(schema.purchaseOrderItems.purchaseOrderId, purchaseOrderId));
  }

  private async requireValidItems(tx: Database, items: PurchaseOrderItemInput[]): Promise<void> {
    for (const item of items) {
      if (item.quantity <= 0) throw new BadRequestException("quantity must be positive");
      if (item.unitCostMinor < 0n) throw new BadRequestException("unitCostMinor must not be negative");

      const itemRows = await tx.select({ id: schema.inventoryItems.id }).from(schema.inventoryItems).where(eq(schema.inventoryItems.id, item.itemId));
      if (itemRows.length === 0) throw new NotFoundException(ITEM_NOT_FOUND);

      const unitRows = await tx.select({ id: schema.units.id }).from(schema.units).where(eq(schema.units.id, item.unitId));
      if (unitRows.length === 0) throw new NotFoundException(UNIT_NOT_FOUND);
    }
  }

  private async insertItems(tx: Database, restaurantId: string, purchaseOrderId: string, currency: string, items: PurchaseOrderItemInput[]): Promise<PurchaseOrderItemRecord[]> {
    return tx
      .insert(schema.purchaseOrderItems)
      .values(
        items.map((item) => ({
          restaurantId,
          purchaseOrderId,
          itemId: item.itemId,
          quantity: item.quantity,
          unitId: item.unitId,
          unitCostMinor: item.unitCostMinor,
          currency,
        })),
      )
      .returning();
  }
}
