import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { add, applyFixedDiscount, applyPercentageDiscount, money, multiply, sum, type Money } from "@mezbaan/domain";
import { and, eq, inArray } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";
import { ManagerPinService } from "./manager-pin.service.js";

export interface DiscountReasonCodeRecord {
  id: string;
  code: string;
  label: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SetDiscountReasonCodeParams {
  restaurantId: string;
  actorUserId: string;
  code: string;
  label: string;
  isActive?: boolean;
}

export interface DiscountLimitsRecord {
  maxUnapprovedPercentBasisPoints: number | null;
  maxUnapprovedAmountMinor: bigint | null;
}

export interface SetDiscountLimitsParams {
  restaurantId: string;
  actorUserId: string;
  maxUnapprovedPercentBasisPoints?: number | null;
  maxUnapprovedAmountMinor?: bigint | null;
}

interface DiscountSpec {
  restaurantId: string;
  actorUserId: string;
  orderId: string;
  percentBasisPoints?: number;
  amountMinor?: bigint;
  reasonCode: string;
  managerUserId?: string;
  managerPin?: string;
}

export interface ApplyItemDiscountParams extends DiscountSpec {
  itemId: string;
}

export type ApplyBillDiscountParams = DiscountSpec;

export interface DiscountOutcome {
  discountMinor: bigint;
  approvedByUserId: string | null;
}

const ORDER_NOT_FOUND = "Order not found";
const ORDER_NOT_OPEN = "a discount can only be applied to an open order";
const ITEM_NOT_FOUND = "Order item not found";
const EXACTLY_ONE_DISCOUNT_TYPE = "exactly one of percentBasisPoints or amountMinor must be given";
const PERCENT_OUT_OF_RANGE = "percentBasisPoints must be between 1 and 10000 (0.01%–100%)";
const AMOUNT_MUST_BE_POSITIVE = "amountMinor must be greater than zero";
const REASON_CODE_NOT_FOUND = "this discount reason code doesn't exist or is no longer active";
const ITEM_VOIDED = "this item has been voided and can no longer be discounted";
const APPROVAL_REQUIRED = "this discount exceeds your own-authority limit and needs a manager's approval (managerUserId and managerPin)";

/**
 * P2-22: bill-level and item-level discounts, with a configurable
 * own-authority limit and manager-PIN approval above it — the first real
 * sensitive-action flow to actually call ManagerPinService (P1-13), which
 * had nothing to wire into until now. Reuses packages/domain's existing
 * applyPercentageDiscount/applyFixedDiscount (P1-07) rather than
 * reimplementing clamp-to-zero discount math — a discount can never make a
 * line or bill owe the customer money, and that's already handled there.
 *
 * A discount is a recorded reduction, never a rewrite of unitPriceMinor
 * itself (rule 6: "discounts are always recorded... never hide or
 * under-report a sale") — order_items/orders keep their own discount
 * columns (at most one of percent/amount) alongside the untouched price,
 * and OrdersService's own total computation (computeOrderTotal,
 * InvoicesService.generate) is what actually subtracts it.
 */
@Injectable()
export class DiscountsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
    private readonly managerPinService: ManagerPinService,
  ) {}

  async listReasonCodes(restaurantId: string): Promise<DiscountReasonCodeRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) => tx.select().from(schema.discountReasonCodes));
  }

  async setReasonCode(params: SetDiscountReasonCodeParams): Promise<DiscountReasonCodeRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .insert(schema.discountReasonCodes)
        .values({ restaurantId: params.restaurantId, code: params.code, label: params.label, isActive: params.isActive ?? true })
        .onConflictDoUpdate({
          target: [schema.discountReasonCodes.restaurantId, schema.discountReasonCodes.code],
          set: { label: params.label, isActive: params.isActive ?? true, updatedAt: new Date() },
        })
        .returning();
      const reasonCode = rows[0];
      if (!reasonCode) throw new Error("setReasonCode: upsert returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "discount_reason_code.set", targetType: "discount_reason_code", targetId: reasonCode.id, metadata: { code: params.code } },
        tx,
      );
      return reasonCode;
    });
  }

  async getLimits(restaurantId: string): Promise<DiscountLimitsRecord> {
    return withTenant(this.db, { restaurantId }, async (tx) => {
      const rows = await tx
        .select({ maxUnapprovedPercentBasisPoints: schema.discountLimitSettings.maxUnapprovedPercentBasisPoints, maxUnapprovedAmountMinor: schema.discountLimitSettings.maxUnapprovedAmountMinor })
        .from(schema.discountLimitSettings);
      return rows[0] ?? { maxUnapprovedPercentBasisPoints: null, maxUnapprovedAmountMinor: null };
    });
  }

  async setLimits(params: SetDiscountLimitsParams): Promise<DiscountLimitsRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const existingRows = await tx.select({ id: schema.discountLimitSettings.id }).from(schema.discountLimitSettings);
      const existing = existingRows[0];

      const values = {
        maxUnapprovedPercentBasisPoints: params.maxUnapprovedPercentBasisPoints ?? null,
        maxUnapprovedAmountMinor: params.maxUnapprovedAmountMinor ?? null,
        updatedByUserId: params.actorUserId,
      };
      const rows = existing
        ? await tx.update(schema.discountLimitSettings).set({ ...values, updatedAt: new Date() }).where(eq(schema.discountLimitSettings.id, existing.id)).returning()
        : await tx.insert(schema.discountLimitSettings).values({ restaurantId: params.restaurantId, ...values }).returning();
      const settings = rows[0];
      if (!settings) throw new Error("setLimits: upsert returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "discount_limits.set", targetType: "discount_limit_settings", targetId: settings.id },
        tx,
      );
      return settings;
    });
  }

  /** Item-level: discounts one line on an open order. */
  async applyItemDiscount(params: ApplyItemDiscountParams): Promise<DiscountOutcome> {
    const { percentBasisPoints, amountMinor } = validateDiscountSpec(params);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const order = await this.requireOpenOrder(tx, params.restaurantId, params.orderId);
      await this.requireActiveReasonCode(tx, params.reasonCode);

      const itemRows = await tx
        .select()
        .from(schema.orderItems)
        .where(and(eq(schema.orderItems.id, params.itemId), eq(schema.orderItems.restaurantId, params.restaurantId)));
      const item = itemRows[0];
      if (!item || item.orderId !== params.orderId) throw new NotFoundException(ITEM_NOT_FOUND);
      if (item.voidedAt !== null) throw new BadRequestException(ITEM_VOIDED);

      const modifierRows = await tx.select().from(schema.orderItemModifiers).where(eq(schema.orderItemModifiers.orderItemId, item.id));
      const lineTotal = computeLineTotal(item, modifierRows);

      const { discount, approvedByUserId } = await this.resolveDiscount(tx, {
        restaurantId: params.restaurantId,
        base: lineTotal,
        percentBasisPoints,
        amountMinor,
        managerUserId: params.managerUserId,
        managerPin: params.managerPin,
        branchId: order.branchId,
        action: "order_item.discount",
      });

      await tx
        .update(schema.orderItems)
        .set({
          discountPercentBasisPoints: percentBasisPoints ?? null,
          discountAmountMinor: amountMinor ?? null,
          discountReasonCode: params.reasonCode,
          discountApprovedByUserId: approvedByUserId,
          updatedAt: new Date(),
        })
        .where(eq(schema.orderItems.id, item.id));

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "order_item.discount_applied",
          targetType: "order_item",
          targetId: item.id,
          metadata: { reasonCode: params.reasonCode, percentBasisPoints, amountMinor: amountMinor?.toString(), discountMinor: discount.amountMinor.toString(), approvedByUserId },
        },
        tx,
      );

      return { discountMinor: discount.amountMinor, approvedByUserId };
    });
  }

  async removeItemDiscount(params: { restaurantId: string; actorUserId: string; orderId: string; itemId: string }): Promise<void> {
    await withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      await this.requireOpenOrder(tx, params.restaurantId, params.orderId);
      const rows = await tx
        .update(schema.orderItems)
        .set({ discountPercentBasisPoints: null, discountAmountMinor: null, discountReasonCode: null, discountApprovedByUserId: null, updatedAt: new Date() })
        .where(and(eq(schema.orderItems.id, params.itemId), eq(schema.orderItems.restaurantId, params.restaurantId)))
        .returning({ id: schema.orderItems.id, orderId: schema.orderItems.orderId });
      const item = rows[0];
      if (!item || item.orderId !== params.orderId) throw new NotFoundException(ITEM_NOT_FOUND);

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "order_item.discount_removed", targetType: "order_item", targetId: item.id },
        tx,
      );
    });
  }

  /** Bill-level: discounts the whole order's current subtotal (every item, post item-discounts). Only meaningful for a whole-order invoice — see orders.ts's own schema comment. */
  async applyBillDiscount(params: ApplyBillDiscountParams): Promise<DiscountOutcome> {
    const { percentBasisPoints, amountMinor } = validateDiscountSpec(params);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const order = await this.requireOpenOrder(tx, params.restaurantId, params.orderId);
      await this.requireActiveReasonCode(tx, params.reasonCode);

      // P2-23: a voided item contributes nothing to the bill-level base either —
      // same reasoning as computeOrderTotal, and the same empty-array guard
      // sum() requires if every remaining item happens to be voided.
      const itemRows = (await tx.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, params.orderId))).filter((item) => item.voidedAt === null);
      const modifierRows = await loadAllModifiers(tx, itemRows.map((i) => i.id));
      const subtotal = itemRows.length === 0 ? money(0n, order.currency) : sum(itemRows.map((item) => computeLineTotal(item, modifierRows.filter((m) => m.orderItemId === item.id))));

      const { discount, approvedByUserId } = await this.resolveDiscount(tx, {
        restaurantId: params.restaurantId,
        base: subtotal,
        percentBasisPoints,
        amountMinor,
        managerUserId: params.managerUserId,
        managerPin: params.managerPin,
        branchId: order.branchId,
        action: "order.discount",
      });

      await tx
        .update(schema.orders)
        .set({
          discountPercentBasisPoints: percentBasisPoints ?? null,
          discountAmountMinor: amountMinor ?? null,
          discountReasonCode: params.reasonCode,
          discountApprovedByUserId: approvedByUserId,
          updatedAt: new Date(),
        })
        .where(eq(schema.orders.id, params.orderId));

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "order.discount_applied",
          targetType: "order",
          targetId: params.orderId,
          metadata: { reasonCode: params.reasonCode, percentBasisPoints, amountMinor: amountMinor?.toString(), discountMinor: discount.amountMinor.toString(), approvedByUserId },
        },
        tx,
      );

      return { discountMinor: discount.amountMinor, approvedByUserId };
    });
  }

  async removeBillDiscount(params: { restaurantId: string; actorUserId: string; orderId: string }): Promise<void> {
    await withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      await this.requireOpenOrder(tx, params.restaurantId, params.orderId);
      await tx
        .update(schema.orders)
        .set({ discountPercentBasisPoints: null, discountAmountMinor: null, discountReasonCode: null, discountApprovedByUserId: null, updatedAt: new Date() })
        .where(eq(schema.orders.id, params.orderId));

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "order.discount_removed", targetType: "order", targetId: params.orderId },
        tx,
      );
    });
  }

  private async requireOpenOrder(tx: Database, restaurantId: string, orderId: string): Promise<{ branchId: string; currency: string }> {
    const rows = await tx
      .select()
      .from(schema.orders)
      .where(and(eq(schema.orders.id, orderId), eq(schema.orders.restaurantId, restaurantId)));
    const order = rows[0];
    if (!order) throw new NotFoundException(ORDER_NOT_FOUND);
    if (order.status !== "open") throw new BadRequestException(ORDER_NOT_OPEN);
    return order;
  }

  private async requireActiveReasonCode(tx: Database, code: string): Promise<void> {
    const rows = await tx.select({ isActive: schema.discountReasonCodes.isActive }).from(schema.discountReasonCodes).where(eq(schema.discountReasonCodes.code, code));
    if (!rows[0] || !rows[0].isActive) throw new BadRequestException(REASON_CODE_NOT_FOUND);
  }

  /** Computes the discount amount, decides whether it needs manager approval against this restaurant's own-authority limit, and runs that approval if so. */
  private async resolveDiscount(
    tx: Database,
    params: {
      restaurantId: string;
      base: Money;
      percentBasisPoints?: number;
      amountMinor?: bigint;
      managerUserId?: string;
      managerPin?: string;
      branchId: string;
      action: string;
    },
  ): Promise<{ discount: Money; approvedByUserId: string | null }> {
    const { discount } =
      params.percentBasisPoints !== undefined
        ? applyPercentageDiscount(params.base, params.percentBasisPoints)
        : applyFixedDiscount(params.base, money(params.amountMinor!, params.base.currency));

    const limitsRows = await tx
      .select({ maxUnapprovedPercentBasisPoints: schema.discountLimitSettings.maxUnapprovedPercentBasisPoints, maxUnapprovedAmountMinor: schema.discountLimitSettings.maxUnapprovedAmountMinor })
      .from(schema.discountLimitSettings);
    const limits = limitsRows[0] ?? { maxUnapprovedPercentBasisPoints: null, maxUnapprovedAmountMinor: null };

    const needsApproval =
      params.percentBasisPoints !== undefined
        ? limits.maxUnapprovedPercentBasisPoints === null || params.percentBasisPoints > limits.maxUnapprovedPercentBasisPoints
        : limits.maxUnapprovedAmountMinor === null || discount.amountMinor > limits.maxUnapprovedAmountMinor;

    if (!needsApproval) return { discount, approvedByUserId: null };

    if (!params.managerUserId || !params.managerPin) throw new BadRequestException(APPROVAL_REQUIRED);

    await this.managerPinService.approve({
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      managerUserId: params.managerUserId,
      pin: params.managerPin,
      requiredPermission: "pos.discount.approve",
      action: params.action,
    });

    return { discount, approvedByUserId: params.managerUserId };
  }
}

function validateDiscountSpec(params: { percentBasisPoints?: number; amountMinor?: bigint }): { percentBasisPoints?: number; amountMinor?: bigint } {
  if ((params.percentBasisPoints !== undefined) === (params.amountMinor !== undefined)) {
    throw new BadRequestException(EXACTLY_ONE_DISCOUNT_TYPE);
  }
  if (params.percentBasisPoints !== undefined && (params.percentBasisPoints < 1 || params.percentBasisPoints > 10_000)) {
    throw new BadRequestException(PERCENT_OUT_OF_RANGE);
  }
  if (params.amountMinor !== undefined && params.amountMinor <= 0n) {
    throw new BadRequestException(AMOUNT_MUST_BE_POSITIVE);
  }
  return params;
}

async function loadAllModifiers(tx: Database, orderItemIds: string[]): Promise<Array<typeof schema.orderItemModifiers.$inferSelect>> {
  if (orderItemIds.length === 0) return [];
  return tx.select().from(schema.orderItemModifiers).where(inArray(schema.orderItemModifiers.orderItemId, orderItemIds));
}

function computeLineTotal(item: typeof schema.orderItems.$inferSelect, modifiers: Array<typeof schema.orderItemModifiers.$inferSelect>): Money {
  const base = multiply(money(item.unitPriceMinor, item.currency), item.quantity);
  const modifiersTotal = modifiers.length > 0 ? sum(modifiers.map((m) => multiply(money(m.unitPriceMinor, m.currency), m.quantity))) : money(0n, item.currency);
  return add(base, modifiersTotal);
}
