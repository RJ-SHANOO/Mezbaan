import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface KitchenTicketModifierRecord {
  name: string;
  quantity: number;
}

export interface KitchenTicketItemRecord {
  orderItemId: string;
  name: string;
  quantity: number;
  notes: string | null;
  seatNumber: number | null;
  course: string | null;
  modifiers: KitchenTicketModifierRecord[];
  voided: boolean;
}

export interface KitchenTicketRecord {
  orderId: string;
  branchId: string;
  tableId: string | null;
  orderType: "dine_in" | "takeaway" | "delivery";
  stationId: string | null;
  stationName: string | null;
  printerHost: string | null;
  printerPort: number | null;
  rush: boolean;
  firedAt: Date;
  firedByUserId: string | null;
  bumped: boolean;
  bumpedAt: Date | null;
  bumpedByUserId: string | null;
  items: KitchenTicketItemRecord[];
}

export interface GetKitchenTicketsParams {
  restaurantId: string;
  branchId?: string;
  stationId?: string;
  orderId?: string;
  includeBumped?: boolean;
  since?: Date;
}

export interface BumpTicketParams {
  restaurantId: string;
  branchId: string;
  actorUserId: string;
  orderId: string;
  firedAt: Date;
  stationId: string | null;
}

export interface RecallTicketParams {
  restaurantId: string;
  actorUserId: string;
  orderId: string;
  firedAt: Date;
  stationId: string | null;
}

export interface OrderReadyParams {
  restaurantId: string;
  branchId: string;
  orderId: string;
}

const ORDER_NOT_FOUND = "Order not found";
const TICKET_NOT_BUMPED = "This ticket hasn't been bumped";

/**
 * P3-02/P3-03: a money-free read of what's been fired to the kitchen (rule
 * 18 — no money field is ever selected here, not even indirectly through a
 * shared response type), plus bump/recall for the live queue. One ticket =
 * every item fired together (same order, same exact firedAt timestamp —
 * OrderItemsService.fireItems stamps one Date across a whole fire call)
 * that resolves to the same station, via P3-01's routing rules. Station
 * resolution is done in bulk here rather than by calling
 * KitchenRoutingRulesService.resolveStationForProduct per item, to avoid an
 * N+1 query per ticket list. Bump state lives in kitchen_ticket_states,
 * keyed by the same (orderId, firedAt, stationId) composite identity.
 */
@Injectable()
export class KitchenTicketsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async getTickets(params: GetKitchenTicketsParams): Promise<KitchenTicketRecord[]> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .select({
          item: schema.orderItems,
          orderBranchId: schema.orders.branchId,
          orderTableId: schema.orders.tableId,
          orderType: schema.orders.orderType,
        })
        .from(schema.orderItems)
        .innerJoin(schema.orders, eq(schema.orderItems.orderId, schema.orders.id))
        .where(
          and(
            isNotNull(schema.orderItems.firedAt),
            params.orderId !== undefined ? eq(schema.orderItems.orderId, params.orderId) : undefined,
            params.branchId !== undefined ? eq(schema.orders.branchId, params.branchId) : undefined,
            params.since !== undefined ? gte(schema.orderItems.firedAt, params.since) : undefined,
          ),
        );
      if (rows.length === 0) return [];

      const variantIds = [...new Set(rows.filter((r) => r.item.variantId !== null).map((r) => r.item.variantId!))];
      const variantRows =
        variantIds.length > 0
          ? await tx.select({ id: schema.productVariants.id, name: schema.productVariants.name, productId: schema.productVariants.productId }).from(schema.productVariants).where(inArray(schema.productVariants.id, variantIds))
          : [];
      const variantById = new Map(variantRows.map((v) => [v.id, v]));

      const productIdForItem = new Map<string, string>();
      for (const r of rows) {
        const productId = r.item.productId ?? variantById.get(r.item.variantId ?? "")?.productId ?? null;
        if (productId) productIdForItem.set(r.item.id, productId);
      }

      const distinctProductIds = [...new Set(productIdForItem.values())];
      const productRows =
        distinctProductIds.length > 0
          ? await tx.select({ id: schema.products.id, name: schema.products.name, categoryId: schema.products.categoryId }).from(schema.products).where(inArray(schema.products.id, distinctProductIds))
          : [];
      const productById = new Map(productRows.map((p) => [p.id, p]));

      const distinctBranchIds = [...new Set(rows.map((r) => r.orderBranchId))];
      const ruleRows =
        distinctBranchIds.length > 0 ? await tx.select().from(schema.kitchenRoutingRules).where(inArray(schema.kitchenRoutingRules.branchId, distinctBranchIds)) : [];
      const productRuleMap = new Map<string, string>();
      const categoryRuleMap = new Map<string, string>();
      for (const rule of ruleRows) {
        if (rule.productId !== null) productRuleMap.set(`${rule.branchId}:${rule.productId}`, rule.stationId);
        if (rule.categoryId !== null) categoryRuleMap.set(`${rule.branchId}:${rule.categoryId}`, rule.stationId);
      }

      const resolveStation = (branchId: string, productId: string | null): string | null => {
        if (!productId) return null;
        const direct = productRuleMap.get(`${branchId}:${productId}`);
        if (direct) return direct;
        const product = productById.get(productId);
        if (!product) return null;
        return categoryRuleMap.get(`${branchId}:${product.categoryId}`) ?? null;
      };

      const stationRows =
        distinctBranchIds.length > 0
          ? await tx
              .select({ id: schema.kitchenStations.id, name: schema.kitchenStations.name, printerHost: schema.kitchenStations.printerHost, printerPort: schema.kitchenStations.printerPort })
              .from(schema.kitchenStations)
              .where(inArray(schema.kitchenStations.branchId, distinctBranchIds))
          : [];
      const stationById = new Map(stationRows.map((s) => [s.id, s]));

      const itemIds = rows.map((r) => r.item.id);
      const modifierRows = await tx
        .select({ orderItemId: schema.orderItemModifiers.orderItemId, modifierOptionId: schema.orderItemModifiers.modifierOptionId, quantity: schema.orderItemModifiers.quantity })
        .from(schema.orderItemModifiers)
        .where(inArray(schema.orderItemModifiers.orderItemId, itemIds));
      const modifierOptionIds = [...new Set(modifierRows.map((m) => m.modifierOptionId))];
      const modifierOptionRows =
        modifierOptionIds.length > 0
          ? await tx.select({ id: schema.modifierOptions.id, name: schema.modifierOptions.name }).from(schema.modifierOptions).where(inArray(schema.modifierOptions.id, modifierOptionIds))
          : [];
      const modifierNameById = new Map(modifierOptionRows.map((m) => [m.id, m.name]));

      const distinctOrderIds = [...new Set(rows.map((r) => r.item.orderId))];
      const bumpRows = await tx.select().from(schema.kitchenTicketStates).where(inArray(schema.kitchenTicketStates.orderId, distinctOrderIds));
      const bumpByKey = new Map(bumpRows.map((b) => [`${b.orderId}:${b.firedAt.getTime()}:${b.stationId ?? "unrouted"}`, b]));

      const tickets = new Map<string, KitchenTicketRecord>();
      for (const r of rows) {
        const productId = productIdForItem.get(r.item.id) ?? null;
        const stationId = resolveStation(r.orderBranchId, productId);
        if (params.stationId !== undefined && stationId !== params.stationId) continue;

        const firedAt = r.item.firedAt!;
        const key = `${r.item.orderId}:${firedAt.getTime()}:${stationId ?? "unrouted"}`;
        const bump = bumpByKey.get(key);
        if (bump && params.includeBumped !== true) continue;

        let ticket = tickets.get(key);
        if (!ticket) {
          const station = stationId !== null ? stationById.get(stationId) : undefined;
          ticket = {
            orderId: r.item.orderId,
            branchId: r.orderBranchId,
            tableId: r.orderTableId,
            orderType: r.orderType,
            stationId,
            stationName: station?.name ?? null,
            printerHost: station?.printerHost ?? null,
            printerPort: station?.printerPort ?? null,
            rush: r.item.rush,
            firedAt,
            firedByUserId: r.item.firedByUserId,
            bumped: bump !== undefined,
            bumpedAt: bump?.bumpedAt ?? null,
            bumpedByUserId: bump?.bumpedByUserId ?? null,
            items: [],
          };
          tickets.set(key, ticket);
        }

        const variant = r.item.variantId !== null ? variantById.get(r.item.variantId) : undefined;
        const product = productId !== null ? productById.get(productId) : undefined;
        const name = variant && product ? `${product.name} (${variant.name})` : (product?.name ?? variant?.name ?? "");

        ticket.items.push({
          orderItemId: r.item.id,
          name,
          quantity: r.item.quantity,
          notes: r.item.notes,
          seatNumber: r.item.seatNumber,
          course: r.item.course,
          modifiers: modifierRows
            .filter((m) => m.orderItemId === r.item.id)
            .map((m) => ({ name: modifierNameById.get(m.modifierOptionId) ?? "", quantity: m.quantity })),
          voided: r.item.voidedAt !== null,
        });
      }

      return [...tickets.values()].sort((a, b) => a.firedAt.getTime() - b.firedAt.getTime());
    });
  }

  async bumpTicket(params: BumpTicketParams): Promise<void> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const orderRows = await tx
        .select({ id: schema.orders.id })
        .from(schema.orders)
        .where(and(eq(schema.orders.id, params.orderId), eq(schema.orders.restaurantId, params.restaurantId), eq(schema.orders.branchId, params.branchId)));
      if (orderRows.length === 0) throw new NotFoundException(ORDER_NOT_FOUND);

      const existing = await this.findBumpState(tx, params.restaurantId, params.orderId, params.firedAt, params.stationId);
      if (existing) return; // idempotent — tapping bump twice is a no-op, not an error

      const rows = await tx
        .insert(schema.kitchenTicketStates)
        .values({
          restaurantId: params.restaurantId,
          branchId: params.branchId,
          orderId: params.orderId,
          firedAt: params.firedAt,
          stationId: params.stationId,
          bumpedByUserId: params.actorUserId,
        })
        .returning();
      const bump = rows[0];
      if (!bump) throw new Error("bumpTicket: insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          branchId: params.branchId,
          actorUserId: params.actorUserId,
          action: "kitchen_ticket.bumped",
          targetType: "kitchen_ticket",
          targetId: bump.id,
          metadata: { orderId: params.orderId, firedAt: params.firedAt.toISOString(), stationId: params.stationId },
        },
        tx,
      );
    });
  }

  async recallTicket(params: RecallTicketParams): Promise<void> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const existing = await this.findBumpState(tx, params.restaurantId, params.orderId, params.firedAt, params.stationId);
      if (!existing) throw new BadRequestException(TICKET_NOT_BUMPED);

      await tx.delete(schema.kitchenTicketStates).where(eq(schema.kitchenTicketStates.id, existing.id));

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          branchId: existing.branchId,
          actorUserId: params.actorUserId,
          action: "kitchen_ticket.recalled",
          targetType: "kitchen_ticket",
          targetId: existing.id,
          metadata: { orderId: params.orderId, firedAt: params.firedAt.toISOString(), stationId: params.stationId },
        },
        tx,
      );
    });
  }

  /** True once every fired, non-voided item on this order belongs to a bumped ticket. False if nothing's been fired yet. */
  async isOrderReady(params: OrderReadyParams): Promise<boolean> {
    const tickets = await this.getTickets({ restaurantId: params.restaurantId, branchId: params.branchId, orderId: params.orderId, includeBumped: true });
    const relevant = tickets.filter((t) => t.items.some((i) => !i.voided));
    if (relevant.length === 0) return false;
    return relevant.every((t) => t.bumped);
  }

  private async findBumpState(tx: Database, restaurantId: string, orderId: string, firedAt: Date, stationId: string | null): Promise<typeof schema.kitchenTicketStates.$inferSelect | undefined> {
    const rows = await tx
      .select()
      .from(schema.kitchenTicketStates)
      .where(
        and(
          eq(schema.kitchenTicketStates.restaurantId, restaurantId),
          eq(schema.kitchenTicketStates.orderId, orderId),
          eq(schema.kitchenTicketStates.firedAt, firedAt),
          stationId !== null ? eq(schema.kitchenTicketStates.stationId, stationId) : isNull(schema.kitchenTicketStates.stationId),
        ),
      );
    return rows[0];
  }
}
