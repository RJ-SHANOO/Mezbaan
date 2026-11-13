import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq, inArray } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";
import { PriceResolutionService } from "./price-resolution.service.js";

export interface OrderItemModifierRecord {
  id: string;
  modifierOptionId: string;
  quantity: number;
  unitPriceMinor: bigint;
  currency: string;
}

export interface OrderItemRecord {
  id: string;
  orderId: string;
  productId: string | null;
  variantId: string | null;
  quantity: number;
  unitPriceMinor: bigint;
  currency: string;
  priceListId: string;
  priceListVersion: number;
  notes: string | null;
  seatNumber: number | null;
  course: string | null;
  modifiers: OrderItemModifierRecord[];
  createdAt: Date;
  updatedAt: Date;
}

export interface AddOrderItemParams {
  restaurantId: string;
  actorUserId: string;
  orderId: string;
  productId?: string;
  variantId?: string;
  quantity?: number;
  notes?: string;
  seatNumber?: number;
  course?: string;
  modifierOptionIds?: string[];
}

export interface UpdateOrderItemParams {
  restaurantId: string;
  actorUserId: string;
  orderId: string;
  itemId: string;
  quantity?: number;
  notes?: string | null;
  seatNumber?: number | null;
  course?: string | null;
}

export interface RemoveOrderItemParams {
  restaurantId: string;
  actorUserId: string;
  orderId: string;
  itemId: string;
}

const EXACTLY_ONE_REFERENCE = "exactly one of productId or variantId must be set";
const ORDER_NOT_FOUND = "Order not found";
const ORDER_NOT_OPEN = "this order is not open";
const ITEM_NOT_FOUND = "Order item not found";
const NOT_PRICED = "this item has no price configured for this branch and order type";
const UNKNOWN_MODIFIER_OPTION = "one of the selected modifier options doesn't exist";
const MODIFIER_NOT_OFFERED = "one of the selected modifier options isn't offered on this product";

/**
 * P2-12: "the cart." Every add resolves and snapshots a real price via
 * PriceResolutionService (rule 3) and refuses to add an item with no price
 * configured at all (rule 6 — never silently sell something for free).
 * Modifier selections are validated against whichever groups are actually
 * attached to the product (P2-02's product_modifier_groups) and each
 * group's own min/max — the same rule ModifierGroupsService enforces when
 * a group is defined, now enforced again at the point it's actually used.
 */
@Injectable()
export class OrderItemsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
    private readonly priceResolutionService: PriceResolutionService,
  ) {}

  async list(restaurantId: string, orderId: string): Promise<OrderItemRecord[]> {
    return withTenant(this.db, { restaurantId }, async (tx) => {
      const items = await tx.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, orderId));
      return this.attachModifiers(tx, items);
    });
  }

  async addItem(params: AddOrderItemParams): Promise<OrderItemRecord> {
    if ((params.productId === undefined) === (params.variantId === undefined)) {
      throw new BadRequestException(EXACTLY_ONE_REFERENCE);
    }

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const order = await this.requireOpenOrder(tx, params.orderId);

      const priced = await this.priceResolutionService.resolvePrice({
        restaurantId: params.restaurantId,
        branchId: order.branchId,
        orderType: order.orderType,
        productId: params.productId,
        variantId: params.variantId,
      });
      if (!priced) throw new BadRequestException(NOT_PRICED);

      const modifierOptionIds = params.modifierOptionIds ?? [];
      const resolvedModifiers = await this.validateAndPriceModifiers(tx, params, order, modifierOptionIds, priced.currency);

      const itemRows = await tx
        .insert(schema.orderItems)
        .values({
          restaurantId: params.restaurantId,
          orderId: params.orderId,
          productId: params.productId ?? null,
          variantId: params.variantId ?? null,
          quantity: params.quantity ?? 1,
          unitPriceMinor: priced.unitPriceMinor,
          currency: priced.currency,
          priceListId: priced.priceListId,
          priceListVersion: priced.version,
          notes: params.notes ?? null,
          seatNumber: params.seatNumber ?? null,
          course: params.course ?? null,
        })
        .returning();
      const item = itemRows[0];
      if (!item) throw new Error("addItem: order item insert returned no row");

      const modifierRecords: OrderItemModifierRecord[] = [];
      for (const modifier of resolvedModifiers) {
        const rows = await tx
          .insert(schema.orderItemModifiers)
          .values({
            restaurantId: params.restaurantId,
            orderItemId: item.id,
            modifierOptionId: modifier.modifierOptionId,
            unitPriceMinor: modifier.unitPriceMinor,
            currency: modifier.currency,
            priceListId: modifier.priceListId,
            priceListVersion: modifier.priceListVersion,
          })
          .returning();
        const row = rows[0];
        if (!row) throw new Error("addItem: order item modifier insert returned no row");
        modifierRecords.push(row);
      }

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "order_item.added",
          targetType: "order_item",
          targetId: item.id,
          metadata: { orderId: params.orderId, productId: item.productId, variantId: item.variantId, quantity: item.quantity },
        },
        tx,
      );
      return { ...item, modifiers: modifierRecords };
    });
  }

  async updateItem(params: UpdateOrderItemParams): Promise<OrderItemRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      await this.requireOpenOrder(tx, params.orderId);

      const rows = await tx
        .update(schema.orderItems)
        .set({
          ...(params.quantity !== undefined && { quantity: params.quantity }),
          ...(params.notes !== undefined && { notes: params.notes }),
          ...(params.seatNumber !== undefined && { seatNumber: params.seatNumber }),
          ...(params.course !== undefined && { course: params.course }),
          updatedAt: new Date(),
        })
        .where(eq(schema.orderItems.id, params.itemId))
        .returning();
      const item = rows[0];
      if (!item) throw new NotFoundException(ITEM_NOT_FOUND);

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "order_item.updated", targetType: "order_item", targetId: item.id },
        tx,
      );
      const [withModifiers] = await this.attachModifiers(tx, [item]);
      return withModifiers!;
    });
  }

  async removeItem(params: RemoveOrderItemParams): Promise<void> {
    await withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      await this.requireOpenOrder(tx, params.orderId);

      await tx.delete(schema.orderItemModifiers).where(eq(schema.orderItemModifiers.orderItemId, params.itemId));
      const deletedRows = await tx.delete(schema.orderItems).where(eq(schema.orderItems.id, params.itemId)).returning({ id: schema.orderItems.id });
      if (deletedRows.length === 0) throw new NotFoundException(ITEM_NOT_FOUND);

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "order_item.removed", targetType: "order_item", targetId: params.itemId },
        tx,
      );
    });
  }

  private async requireOpenOrder(tx: Database, orderId: string): Promise<{ branchId: string; orderType: "dine_in" | "takeaway" | "delivery" }> {
    const rows = await tx.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    const order = rows[0];
    if (!order) throw new NotFoundException(ORDER_NOT_FOUND);
    if (order.status !== "open") throw new BadRequestException(ORDER_NOT_OPEN);
    return order;
  }

  private async validateAndPriceModifiers(
    tx: Database,
    params: AddOrderItemParams,
    order: { branchId: string; orderType: "dine_in" | "takeaway" | "delivery" },
    modifierOptionIds: string[],
    itemCurrency: string,
  ): Promise<Array<{ modifierOptionId: string; unitPriceMinor: bigint; currency: string; priceListId: string | null; priceListVersion: number | null }>> {
    const optionRows =
      modifierOptionIds.length > 0
        ? await tx.select().from(schema.modifierOptions).where(inArray(schema.modifierOptions.id, modifierOptionIds))
        : [];
    if (optionRows.length !== modifierOptionIds.length) throw new BadRequestException(UNKNOWN_MODIFIER_OPTION);

    const productId = params.productId ?? (await this.productIdForVariant(tx, params.variantId!));
    const attachedGroups = await tx
      .select({ modifierGroupId: schema.productModifierGroups.modifierGroupId })
      .from(schema.productModifierGroups)
      .where(eq(schema.productModifierGroups.productId, productId));
    const attachedGroupIds = new Set(attachedGroups.map((row) => row.modifierGroupId));

    for (const option of optionRows) {
      if (!attachedGroupIds.has(option.modifierGroupId)) throw new BadRequestException(MODIFIER_NOT_OFFERED);
    }

    if (attachedGroupIds.size > 0) {
      const groups = await tx.select().from(schema.modifierGroups).where(inArray(schema.modifierGroups.id, [...attachedGroupIds]));
      for (const group of groups) {
        const selectedCount = optionRows.filter((option) => option.modifierGroupId === group.id).length;
        if (selectedCount < group.minSelections) {
          throw new BadRequestException(`"${group.name}" requires at least ${group.minSelections} selection(s)`);
        }
        if (group.maxSelections !== null && selectedCount > group.maxSelections) {
          throw new BadRequestException(`"${group.name}" allows at most ${group.maxSelections} selection(s)`);
        }
      }
    }

    if (optionRows.length === 0) return [];

    const resolved: Array<{ modifierOptionId: string; unitPriceMinor: bigint; currency: string; priceListId: string | null; priceListVersion: number | null }> = [];
    for (const option of optionRows) {
      const priced = await this.priceResolutionService.resolvePrice({
        restaurantId: params.restaurantId,
        branchId: order.branchId,
        orderType: order.orderType,
        modifierOptionId: option.id,
      });
      resolved.push(
        priced
          ? { modifierOptionId: option.id, unitPriceMinor: priced.unitPriceMinor, currency: priced.currency, priceListId: priced.priceListId, priceListVersion: priced.version }
          // Unpriced (free) modifier — no price list backs it, so there's no
          // currency of its own to report; use the item's own, since a $0
          // amount still needs a currency to be a well-formed Money value.
          : { modifierOptionId: option.id, unitPriceMinor: 0n, currency: itemCurrency, priceListId: null, priceListVersion: null },
      );
    }
    return resolved;
  }

  private async productIdForVariant(tx: Database, variantId: string): Promise<string> {
    const rows = await tx.select({ productId: schema.productVariants.productId }).from(schema.productVariants).where(eq(schema.productVariants.id, variantId));
    return rows[0]?.productId ?? "";
  }

  private async attachModifiers(tx: Database, items: Array<Omit<OrderItemRecord, "modifiers">>): Promise<OrderItemRecord[]> {
    if (items.length === 0) return [];
    const modifierRows = await tx.select().from(schema.orderItemModifiers).where(
      inArray(
        schema.orderItemModifiers.orderItemId,
        items.map((i) => i.id),
      ),
    );
    return items.map((item) => ({ ...item, modifiers: modifierRows.filter((m) => m.orderItemId === item.id) }));
  }
}
