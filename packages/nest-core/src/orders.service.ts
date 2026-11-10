import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";
import type { OrderType } from "./price-lists.service.js";

export type OrderStatus = "open" | "closed" | "cancelled";

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

const ORDER_NOT_FOUND = "Order not found";
const EXACTLY_DINE_IN_HAS_TABLE = "a dine-in order requires a tableId, and only a dine-in order may have one";
const TABLE_ALREADY_OPEN = "this table already has an open order";
const ALREADY_FINAL = "this order is already closed or cancelled";

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
        const tableRows = await tx.select().from(schema.diningTables).where(eq(schema.diningTables.id, params.tableId));
        const table = tableRows[0];
        if (!table) throw new NotFoundException("Table not found");
        if (table.branchId !== params.branchId) throw new BadRequestException("the table does not belong to this branch");

        const openOrderRows = await tx
          .select({ id: schema.orders.id })
          .from(schema.orders)
          .where(and(eq(schema.orders.tableId, params.tableId), eq(schema.orders.status, "open")));
        if (openOrderRows.length > 0) throw new BadRequestException(TABLE_ALREADY_OPEN);
      }

      const rows = await tx
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
      const order = rows[0];
      if (!order) throw new Error("create: order insert returned no row");

      if (params.tableId !== undefined) {
        await tx.update(schema.diningTables).set({ status: "occupied", updatedAt: new Date() }).where(eq(schema.diningTables.id, params.tableId));
      }

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
    return this.finalize(params, "closed", "order.closed");
  }

  async cancel(params: OrderActionParams): Promise<OrderRecord> {
    return this.finalize(params, "cancelled", "order.cancelled");
  }

  private async finalize(params: OrderActionParams, status: "closed" | "cancelled", action: string): Promise<OrderRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const existingRows = await tx.select().from(schema.orders).where(eq(schema.orders.id, params.orderId));
      const existing = existingRows[0];
      if (!existing) throw new NotFoundException(ORDER_NOT_FOUND);
      if (existing.status !== "open") throw new BadRequestException(ALREADY_FINAL);

      const rows = await tx
        .update(schema.orders)
        .set({ status, closedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.orders.id, params.orderId))
        .returning();
      const order = rows[0];
      if (!order) throw new NotFoundException(ORDER_NOT_FOUND);

      if (order.tableId !== null) {
        await tx.update(schema.diningTables).set({ status: "available", updatedAt: new Date() }).where(eq(schema.diningTables.id, order.tableId));
      }

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
}
