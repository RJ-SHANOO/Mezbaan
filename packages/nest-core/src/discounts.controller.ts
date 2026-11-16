import { Body, Controller, Delete, Get, Param, Post, Put, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import {
  ApplyDiscountSchema,
  SetDiscountLimitsSchema,
  SetDiscountReasonCodeSchema,
  type DiscountLimits,
  type DiscountOutcome,
  type DiscountReasonCode,
} from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import {
  DiscountsService,
  type DiscountLimitsRecord,
  type DiscountOutcome as DiscountOutcomeRecord,
  type DiscountReasonCodeRecord,
} from "./discounts.service.js";
import { parseOrBadRequest } from "./validation.js";

const OrderIdParamSchema = z.object({ id: z.string().uuid() });
const ItemDiscountParamSchema = z.object({ orderId: z.string().uuid(), itemId: z.string().uuid() });

function toReasonCodeResponse(row: DiscountReasonCodeRecord): DiscountReasonCode {
  return { id: row.id, code: row.code, label: row.label, isActive: row.isActive, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

function toLimitsResponse(limits: DiscountLimitsRecord): DiscountLimits {
  return {
    maxUnapprovedPercentBasisPoints: limits.maxUnapprovedPercentBasisPoints,
    maxUnapprovedAmountMinor: limits.maxUnapprovedAmountMinor?.toString() ?? null,
  };
}

function toOutcomeResponse(outcome: DiscountOutcomeRecord): DiscountOutcome {
  return { discountMinor: outcome.discountMinor.toString(), approvedByUserId: outcome.approvedByUserId };
}

/** P2-22, admin side: the restaurant-defined reason codes and own-authority
 * limit — same menu.manage tier as tax/service-charge/payment-method
 * settings, lives in CatalogModule for api-admin. */
@Controller("discount-reason-codes")
export class DiscountReasonCodesController {
  constructor(private readonly discountsService: DiscountsService) {}

  @Get()
  @RequirePermission("menu.manage")
  async list(): Promise<DiscountReasonCode[]> {
    const tenant = requireTenant();
    const codes = await this.discountsService.listReasonCodes(tenant.restaurantId);
    return codes.map(toReasonCodeResponse);
  }

  @Put()
  @RequirePermission("menu.manage")
  async set(@Body() body: unknown): Promise<DiscountReasonCode> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(SetDiscountReasonCodeSchema, body);
    const code = await this.discountsService.setReasonCode({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toReasonCodeResponse(code);
  }
}

@Controller("discount-limits")
export class DiscountLimitsController {
  constructor(private readonly discountsService: DiscountsService) {}

  @Get()
  @RequirePermission("menu.manage")
  async get(): Promise<DiscountLimits> {
    const tenant = requireTenant();
    const limits = await this.discountsService.getLimits(tenant.restaurantId);
    return toLimitsResponse(limits);
  }

  @Put()
  @RequirePermission("menu.manage")
  async set(@Body() body: unknown): Promise<DiscountLimits> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(SetDiscountLimitsSchema, body);
    const limits = await this.discountsService.setLimits({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.userId,
      maxUnapprovedPercentBasisPoints: request.maxUnapprovedPercentBasisPoints,
      maxUnapprovedAmountMinor: request.maxUnapprovedAmountMinor !== undefined && request.maxUnapprovedAmountMinor !== null ? BigInt(request.maxUnapprovedAmountMinor) : request.maxUnapprovedAmountMinor,
    });
    return toLimitsResponse(limits);
  }
}

/** P2-22, POS side: applying/removing a discount is gated by pos.sell like any
 * other order edit — the manager-PIN escalation above the own-authority limit
 * happens inside DiscountsService itself (ManagerPinService checks
 * pos.discount.approve against whoever's PIN was entered), not via a
 * different route permission. */
@Controller("orders/:orderId/items/:itemId/discount")
export class OrderItemDiscountController {
  constructor(private readonly discountsService: DiscountsService) {}

  @Post()
  @RequirePermission("pos.sell")
  async apply(@Param() params: unknown, @Body() body: unknown): Promise<DiscountOutcome> {
    const tenant = requireTenant();
    const { orderId, itemId } = parseOrBadRequest(ItemDiscountParamSchema, params);
    const request = parseOrBadRequest(ApplyDiscountSchema, body);
    const outcome = await this.discountsService.applyItemDiscount({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.userId,
      orderId,
      itemId,
      percentBasisPoints: request.percentBasisPoints,
      amountMinor: request.amountMinor !== undefined ? BigInt(request.amountMinor) : undefined,
      reasonCode: request.reasonCode,
      managerUserId: request.managerUserId,
      managerPin: request.managerPin,
    });
    return toOutcomeResponse(outcome);
  }

  @Delete()
  @RequirePermission("pos.sell")
  async remove(@Param() params: unknown): Promise<{ removed: true }> {
    const tenant = requireTenant();
    const { orderId, itemId } = parseOrBadRequest(ItemDiscountParamSchema, params);
    await this.discountsService.removeItemDiscount({ restaurantId: tenant.restaurantId, actorUserId: tenant.userId, orderId, itemId });
    return { removed: true };
  }
}

@Controller("orders/:id/discount")
export class OrderDiscountController {
  constructor(private readonly discountsService: DiscountsService) {}

  @Post()
  @RequirePermission("pos.sell")
  async apply(@Param() params: unknown, @Body() body: unknown): Promise<DiscountOutcome> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(OrderIdParamSchema, params);
    const request = parseOrBadRequest(ApplyDiscountSchema, body);
    const outcome = await this.discountsService.applyBillDiscount({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.userId,
      orderId: id,
      percentBasisPoints: request.percentBasisPoints,
      amountMinor: request.amountMinor !== undefined ? BigInt(request.amountMinor) : undefined,
      reasonCode: request.reasonCode,
      managerUserId: request.managerUserId,
      managerPin: request.managerPin,
    });
    return toOutcomeResponse(outcome);
  }

  @Delete()
  @RequirePermission("pos.sell")
  async remove(@Param() params: unknown): Promise<{ removed: true }> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(OrderIdParamSchema, params);
    await this.discountsService.removeBillDiscount({ restaurantId: tenant.restaurantId, actorUserId: tenant.userId, orderId: id });
    return { removed: true };
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
