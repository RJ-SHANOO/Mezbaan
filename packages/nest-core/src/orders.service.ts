import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import {
  add,
  assertCanTransitionOrderStatus,
  IllegalOrderStatusTransitionError,
  money,
  multiply,
  sum,
  type Money,
  type OrderStatus,
} from "@mezbaan/domain";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";
import { OrderItemsService, type OrderItemRecord } from "./order-items.service.js";
import { isUniqueViolation } from "./pg-error.js";
import type { OrderType } from "./price-lists.service.js";

export type { OrderStatus };

export interface OrderStatusHistoryEntry {
  id: string;
  orderId: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  actorUserId: string;
  reason: string | null;
  createdAt: Date;
}

export interface OrderRecord {
  id: string;
  branchId: string;
  orderType: OrderType;
  tableId: string | null;
  status: OrderStatus;
  currency: string;
  openedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

export interface CreateOrderParams {
  restaurantId: string;
  actorUserId: string;
  branchId: string;
  orderType: OrderType;
  currency: string;
  tableId?: string;
}

export interface ListOrdersParams {
  restaurantId: string;
  branchId?: string;
  status?: OrderStatus;
}

export interface OrderActionParams {
  restaurantId: string;
  orderId: string;
  actorUserId: string;
  reason?: string;
}

export interface OrderTab {
  tableId: string;
  order: OrderRecord | null;
  items: OrderItemRecord[];
  total: Money | null;
}

export interface TransferTableParams {
  restaurantId: string;
  orderId: string;
  actorUserId: string;
  targetTableId: string;
}

export interface MergeTablesParams {
  restaurantId: string;
  orderId: string;
  actorUserId: string;
  targetTableId: string;
}

export interface MergeTablesResult {
  targetOrder: OrderRecord;
  sourceOrderId: string;
}

export interface SplitTableParams {
  restaurantId: string;
  orderId: string;
  actorUserId: string;
  targetTableId: string;
  itemIds: string[];
}

export interface SplitTableResult {
  sourceOrder: OrderRecord;
  newOrder: OrderRecord;
}

const ORDER_NOT_FOUND = "Order not found";
const TABLE_NOT_FOUND = "Table not found";
const EXACTLY_DINE_IN_HAS_TABLE = "a dine-in order requires a tableId, and only a dine-in order may have one";
const TABLE_ALREADY_OPEN = "this table already has an open order";
const TABLE_WRONG_BRANCH = "the table does not belong to this branch";
const ILLEGAL_TRANSITION = "this order's status cannot change that way";
const NOT_DINE_IN = "only a dine-in order can be transferred, merged or split between tables";
const NOT_OCCUPYING = "only an open or held order can be transferred, merged or split";
const SAME_TABLE = "the target table is the same as the order's current table";
const NO_ORDER_ON_TARGET_TABLE = "the target table has no open or held order to merge into";
const CURRENCY_MISMATCH = "cannot merge orders with different currencies";
const ITEM_IDS_REQUIRED = "at least one item must be selected to split";
const ITEMS_NOT_FOUND = "one or more selected items don't belong to this order";
const MUST_LEAVE_ITEM_BEHIND = "a split must leave at least one item on the original order — use transfer to move the whole order instead";
// A table is occupied by whichever order is open or held on it — a held
// ticket is still that customer's table, not a free one.
const TABLE_OCCUPYING_STATUSES = ["open", "held"] as const;

/**
 * P2-09: the order header, with one real behavioral difference per type —
 * a dine-in order occupies its table for as long as it stays open, and
 * frees it again on close/cancel; takeaway and delivery never touch a
 * table at all. That table-occupancy side effect is the concrete "own
 * workflow" this task delivers; status itself has no transition validation
 * yet (P2-13's job) and there are no line items yet (P2-12's job).
 */
@Injectable()
export class OrdersService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
    private readonly orderItemsService: OrderItemsService,
  ) {}

  async list(params: ListOrdersParams): Promise<OrderRecord[]> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.orders)
        .where(
          and(
            params.branchId !== undefined ? eq(schema.orders.branchId, params.branchId) : undefined,
            params.status !== undefined ? eq(schema.orders.status, params.status) : undefined,
          ),
        )
        .orderBy(desc(schema.orders.createdAt)),
    );
  }

  async create(params: CreateOrderParams): Promise<OrderRecord> {
    if ((params.orderType === "dine_in") !== (params.tableId !== undefined)) {
      throw new BadRequestException(EXACTLY_DINE_IN_HAS_TABLE);
    }

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      if (params.tableId !== undefined) {
        await this.requireFreeTableInBranch(tx, params.tableId, params.branchId);
      }

      let rows: OrderRecord[];
      try {
        rows = await tx
          .insert(schema.orders)
          .values({
            restaurantId: params.restaurantId,
            branchId: params.branchId,
            orderType: params.orderType,
            tableId: params.tableId ?? null,
            currency: params.currency,
            openedByUserId: params.actorUserId,
          })
          .returning();
      } catch (error) {
        // P2-16: the pre-check above read-then-decided, which a concurrent
        // request on another terminal can race past. orders_table_occupancy_idx
        // is the real guard — this is what actually catches that race.
        if (isUniqueViolation(error)) throw new BadRequestException(TABLE_ALREADY_OPEN);
        throw error;
      }
      const order = rows[0];
      if (!order) throw new Error("create: order insert returned no row");

      if (params.tableId !== undefined) {
        await tx.update(schema.diningTables).set({ status: "occupied", updatedAt: new Date() }).where(eq(schema.diningTables.id, params.tableId));
      }

      await tx.insert(schema.orderStatusHistory).values({
        restaurantId: params.restaurantId,
        orderId: order.id,
        fromStatus: null,
        toStatus: order.status,
        actorUserId: params.actorUserId,
      });

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "order.opened",
          targetType: "order",
          targetId: order.id,
          metadata: { orderType: order.orderType, branchId: order.branchId, tableId: order.tableId },
        },
        tx,
      );
      return order;
    });
  }

  async close(params: OrderActionParams): Promise<OrderRecord> {
    return this.transition(params, "closed", "order.closed", { freesTable: true });
  }

  async cancel(params: OrderActionParams): Promise<OrderRecord> {
    return this.transition(params, "cancelled", "order.cancelled", { freesTable: true });
  }

  /** P2-14: park an in-progress ticket without billing it — the table (if any) stays occupied. */
  async hold(params: OrderActionParams): Promise<OrderRecord> {
    return this.transition(params, "held", "order.held", { freesTable: false });
  }

  /** P2-14: resume a parked ticket. */
  async recall(params: OrderActionParams): Promise<OrderRecord> {
    return this.transition(params, "open", "order.recalled", { freesTable: false });
  }

  private async transition(
    params: OrderActionParams,
    status: OrderStatus,
    action: string,
    options: { freesTable: boolean },
  ): Promise<OrderRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      // P2-16: lock the row so a second concurrent transition on this same
      // order (another terminal closing while this one cancels, say) waits
      // for this one to commit and then re-reads its real outcome, instead
      // of racing past this check on stale data and silently overwriting it.
      const existingRows = await tx.select().from(schema.orders).where(eq(schema.orders.id, params.orderId)).for("update");
      const existing = existingRows[0];
      if (!existing) throw new NotFoundException(ORDER_NOT_FOUND);
      try {
        assertCanTransitionOrderStatus(existing.status, status);
      } catch (error) {
        if (error instanceof IllegalOrderStatusTransitionError) throw new BadRequestException(ILLEGAL_TRANSITION);
        throw error;
      }

      const rows = await tx
        .update(schema.orders)
        .set({ status, closedAt: options.freesTable ? new Date() : existing.closedAt, updatedAt: new Date() })
        .where(eq(schema.orders.id, params.orderId))
        .returning();
      const order = rows[0];
      if (!order) throw new NotFoundException(ORDER_NOT_FOUND);

      if (options.freesTable && order.tableId !== null) {
        await tx.update(schema.diningTables).set({ status: "available", updatedAt: new Date() }).where(eq(schema.diningTables.id, order.tableId));
      }

      await tx.insert(schema.orderStatusHistory).values({
        restaurantId: params.restaurantId,
        orderId: order.id,
        fromStatus: existing.status,
        toStatus: status,
        actorUserId: params.actorUserId,
        reason: params.reason ?? null,
      });

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action,
          targetType: "order",
          targetId: order.id,
          metadata: { reason: params.reason },
        },
        tx,
      );
      return order;
    });
  }

  async getStatusHistory(params: { restaurantId: string; orderId: string }): Promise<OrderStatusHistoryEntry[]> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const orderRows = await tx.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.id, params.orderId));
      if (!orderRows[0]) throw new NotFoundException(ORDER_NOT_FOUND);

      return tx
        .select()
        .from(schema.orderStatusHistory)
        .where(eq(schema.orderStatusHistory.orderId, params.orderId))
        .orderBy(asc(schema.orderStatusHistory.createdAt));
    });
  }

  /** P2-14: a dine-in table's running tab — the order currently occupying it (open or held), its items, and the running total. */
  async getTableTab(params: { restaurantId: string; tableId: string }): Promise<OrderTab> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const tableRows = await tx.select({ id: schema.diningTables.id }).from(schema.diningTables).where(eq(schema.diningTables.id, params.tableId));
      if (!tableRows[0]) throw new NotFoundException(TABLE_NOT_FOUND);

      const orderRows = await tx
        .select()
        .from(schema.orders)
        .where(and(eq(schema.orders.tableId, params.tableId), inArray(schema.orders.status, TABLE_OCCUPYING_STATUSES)));
      const order = orderRows[0] ?? null;
      if (!order) return { tableId: params.tableId, order: null, items: [], total: null };

      const items = await this.orderItemsService.list(params.restaurantId, order.id);
      const total = computeOrderTotal(items, order.currency);
      return { tableId: params.tableId, order, items, total };
    });
  }

  /** P2-08: move a dine-in order to a different, currently-free table — e.g. the guests change seats. */
  async transferTable(params: TransferTableParams): Promise<OrderRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const source = await this.requireOccupyingDineInOrder(tx, params.orderId);
      if (source.tableId === params.targetTableId) throw new BadRequestException(SAME_TABLE);
      await this.requireFreeTableInBranch(tx, params.targetTableId, source.branchId);

      let rows: OrderRecord[];
      try {
        rows = await tx
          .update(schema.orders)
          .set({ tableId: params.targetTableId, updatedAt: new Date() })
          .where(eq(schema.orders.id, source.id))
          .returning();
      } catch (error) {
        // P2-16: same race as create() — orders_table_occupancy_idx is the real guard.
        if (isUniqueViolation(error)) throw new BadRequestException(TABLE_ALREADY_OPEN);
        throw error;
      }
      const order = rows[0];
      if (!order) throw new NotFoundException(ORDER_NOT_FOUND);

      await tx.update(schema.diningTables).set({ status: "available", updatedAt: new Date() }).where(eq(schema.diningTables.id, source.tableId!));
      await tx.update(schema.diningTables).set({ status: "occupied", updatedAt: new Date() }).where(eq(schema.diningTables.id, params.targetTableId));

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "order.table_transferred",
          targetType: "order",
          targetId: order.id,
          metadata: { fromTableId: source.tableId, toTableId: params.targetTableId },
        },
        tx,
      );
      return order;
    });
  }

  /**
   * P2-08: combine two tables into one order — e.g. two tables are pushed
   * together for one party. All of this order's items move onto whichever
   * order currently occupies targetTableId, then this order is cancelled
   * (same status-history/audit trail as a normal cancel) and its table
   * freed. The target table's own order and occupancy are untouched.
   */
  async mergeTables(params: MergeTablesParams): Promise<MergeTablesResult> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const source = await this.requireOccupyingDineInOrder(tx, params.orderId);
      if (source.tableId === params.targetTableId) throw new BadRequestException(SAME_TABLE);
      const targetOrder = await this.requireOccupiedTableOrder(tx, params.targetTableId, source.branchId);
      if (source.currency !== targetOrder.currency) throw new BadRequestException(CURRENCY_MISMATCH);

      try {
        assertCanTransitionOrderStatus(source.status, "cancelled");
      } catch (error) {
        if (error instanceof IllegalOrderStatusTransitionError) throw new BadRequestException(ILLEGAL_TRANSITION);
        throw error;
      }

      await tx.update(schema.orderItems).set({ orderId: targetOrder.id, updatedAt: new Date() }).where(eq(schema.orderItems.orderId, source.id));

      const cancelledRows = await tx
        .update(schema.orders)
        .set({ status: "cancelled", closedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.orders.id, source.id))
        .returning();
      const cancelledSource = cancelledRows[0];
      if (!cancelledSource) throw new NotFoundException(ORDER_NOT_FOUND);

      await tx.update(schema.diningTables).set({ status: "available", updatedAt: new Date() }).where(eq(schema.diningTables.id, source.tableId!));

      await tx.insert(schema.orderStatusHistory).values({
        restaurantId: params.restaurantId,
        orderId: source.id,
        fromStatus: source.status,
        toStatus: "cancelled",
        actorUserId: params.actorUserId,
        reason: `merged into the order on table ${params.targetTableId}`,
      });

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "order.tables_merged",
          targetType: "order",
          targetId: targetOrder.id,
          metadata: { sourceOrderId: source.id, sourceTableId: source.tableId, targetTableId: params.targetTableId },
        },
        tx,
      );
      return { targetOrder, sourceOrderId: cancelledSource.id };
    });
  }

  /**
   * P2-08: move a subset of this order's items onto a new order at a
   * different, currently-free table — e.g. part of a party splits off to
   * sit elsewhere. At least one item must stay behind; moving everything
   * is just a transfer.
   */
  async splitTable(params: SplitTableParams): Promise<SplitTableResult> {
    if (params.itemIds.length === 0) throw new BadRequestException(ITEM_IDS_REQUIRED);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const source = await this.requireOccupyingDineInOrder(tx, params.orderId);
      if (source.tableId === params.targetTableId) throw new BadRequestException(SAME_TABLE);
      await this.requireFreeTableInBranch(tx, params.targetTableId, source.branchId);

      const existingItemRows = await tx.select({ id: schema.orderItems.id }).from(schema.orderItems).where(eq(schema.orderItems.orderId, source.id));
      const existingItemIds = new Set(existingItemRows.map((row) => row.id));
      const selectedItemIds = new Set(params.itemIds);
      for (const itemId of selectedItemIds) {
        if (!existingItemIds.has(itemId)) throw new NotFoundException(ITEMS_NOT_FOUND);
      }
      if (selectedItemIds.size === existingItemIds.size) throw new BadRequestException(MUST_LEAVE_ITEM_BEHIND);

      let newOrderRows: OrderRecord[];
      try {
        newOrderRows = await tx
          .insert(schema.orders)
          .values({
            restaurantId: params.restaurantId,
            branchId: source.branchId,
            orderType: "dine_in",
            tableId: params.targetTableId,
            currency: source.currency,
            openedByUserId: params.actorUserId,
          })
          .returning();
      } catch (error) {
        // P2-16: same race as create() — orders_table_occupancy_idx is the real guard.
        if (isUniqueViolation(error)) throw new BadRequestException(TABLE_ALREADY_OPEN);
        throw error;
      }
      const newOrder = newOrderRows[0];
      if (!newOrder) throw new Error("splitTable: order insert returned no row");

      await tx.update(schema.orderItems).set({ orderId: newOrder.id, updatedAt: new Date() }).where(inArray(schema.orderItems.id, [...selectedItemIds]));

      await tx.update(schema.diningTables).set({ status: "occupied", updatedAt: new Date() }).where(eq(schema.diningTables.id, params.targetTableId));

      await tx.insert(schema.orderStatusHistory).values({
        restaurantId: params.restaurantId,
        orderId: newOrder.id,
        fromStatus: null,
        toStatus: newOrder.status,
        actorUserId: params.actorUserId,
      });

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "order.split",
          targetType: "order",
          targetId: source.id,
          metadata: { newOrderId: newOrder.id, targetTableId: params.targetTableId, itemIds: [...selectedItemIds] },
        },
        tx,
      );
      return { sourceOrder: source, newOrder };
    });
  }

  /** Loads an order and asserts it's dine-in (has a table) and currently occupying it (open or held). Row-locked (P2-16) — this is always the first read in a transfer/merge/split. */
  private async requireOccupyingDineInOrder(tx: Database, orderId: string): Promise<OrderRecord> {
    const rows = await tx.select().from(schema.orders).where(eq(schema.orders.id, orderId)).for("update");
    const order = rows[0];
    if (!order) throw new NotFoundException(ORDER_NOT_FOUND);
    if (order.tableId === null) throw new BadRequestException(NOT_DINE_IN);
    if (!TABLE_OCCUPYING_STATUSES.includes(order.status as (typeof TABLE_OCCUPYING_STATUSES)[number])) {
      throw new BadRequestException(NOT_OCCUPYING);
    }
    return order;
  }

  /** Loads a table in the given branch and asserts no order currently occupies it. */
  private async requireFreeTableInBranch(tx: Database, tableId: string, branchId: string): Promise<void> {
    const tableRows = await tx.select().from(schema.diningTables).where(eq(schema.diningTables.id, tableId));
    const table = tableRows[0];
    if (!table) throw new NotFoundException(TABLE_NOT_FOUND);
    if (table.branchId !== branchId) throw new BadRequestException(TABLE_WRONG_BRANCH);

    const openOrderRows = await tx
      .select({ id: schema.orders.id })
      .from(schema.orders)
      .where(and(eq(schema.orders.tableId, tableId), inArray(schema.orders.status, TABLE_OCCUPYING_STATUSES)));
    if (openOrderRows.length > 0) throw new BadRequestException(TABLE_ALREADY_OPEN);
  }

  /** Loads a table in the given branch and returns whichever order currently occupies it, if any. Row-locked (P2-16) — mergeTables writes this order's items next. */
  private async requireOccupiedTableOrder(tx: Database, tableId: string, branchId: string): Promise<OrderRecord> {
    const tableRows = await tx.select().from(schema.diningTables).where(eq(schema.diningTables.id, tableId));
    const table = tableRows[0];
    if (!table) throw new NotFoundException(TABLE_NOT_FOUND);
    if (table.branchId !== branchId) throw new BadRequestException(TABLE_WRONG_BRANCH);

    const orderRows = await tx
      .select()
      .from(schema.orders)
      .where(and(eq(schema.orders.tableId, tableId), inArray(schema.orders.status, TABLE_OCCUPYING_STATUSES)))
      .for("update");
    const order = orderRows[0];
    if (!order) throw new BadRequestException(NO_ORDER_ON_TARGET_TABLE);
    return order;
  }
}

/** Shared with InvoicesService (P2-18) — the same pure domain-math subtotal both OrdersService.getTableTab and invoice generation need. */
export function computeOrderTotal(items: OrderItemRecord[], currency: string): Money {
  if (items.length === 0) return money(0n, currency);
  const lineTotals = items.map((item) => {
    const base = multiply(money(item.unitPriceMinor, item.currency), item.quantity);
    const modifiersTotal =
      item.modifiers.length > 0
        ? sum(item.modifiers.map((m) => multiply(money(m.unitPriceMinor, m.currency), m.quantity)))
        : money(0n, item.currency);
    return add(base, modifiersTotal);
  });
  return sum(lineTotals);
}
