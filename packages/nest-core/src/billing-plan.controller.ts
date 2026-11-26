import { Body, Controller, ForbiddenException, Get, Param, Put, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { SetBillingPlanSchema, type BillingPlan } from "@mezbaan/contracts";
import { BillingPlanService, type BillingPlanRecord } from "./billing-plan.service.js";
import { getTenantContext } from "./tenant-context.js";
import { parseOrBadRequest } from "./validation.js";

const RestaurantIdParamSchema = z.object({ restaurantId: z.string().uuid() });

function toBillingPlanResponse(plan: BillingPlanRecord): BillingPlan {
  return {
    planType: plan.planType,
    fixedFeeMinor: plan.fixedFeeMinor?.toString() ?? null,
    fixedFeeCurrency: plan.fixedFeeCurrency,
    billingCycle: plan.billingCycle,
  };
}

/** P3-36: same super-admin-only-write split as FeatureFlagsController —
 * any authenticated member of a restaurant can see their own plan
 * (transparency about what they're being billed), but only a super-admin
 * session can set one, for any restaurant. */
@Controller()
export class BillingPlanController {
  constructor(private readonly billingPlanService: BillingPlanService) {}

  @Get("billing-plan")
  async getMine(): Promise<BillingPlan> {
    const tenant = requireTenant();
    const plan = await this.billingPlanService.getForRestaurant(tenant.restaurantId);
    return toBillingPlanResponse(plan);
  }

  @Get("restaurants/:restaurantId/billing-plan")
  async getForRestaurant(@Param() params: unknown): Promise<BillingPlan> {
    requireSuperAdmin();
    const { restaurantId } = parseOrBadRequest(RestaurantIdParamSchema, params);
    const plan = await this.billingPlanService.getForRestaurantAsSuperAdmin(restaurantId);
    return toBillingPlanResponse(plan);
  }

  @Put("restaurants/:restaurantId/billing-plan")
  async setPlan(@Param() params: unknown, @Body() body: unknown): Promise<BillingPlan> {
    const actor = requireSuperAdmin();
    const { restaurantId } = parseOrBadRequest(RestaurantIdParamSchema, params);
    const input = parseOrBadRequest(SetBillingPlanSchema, body);
    const plan = await this.billingPlanService.setPlan({
      restaurantId,
      actorUserId: actor.userId,
      planType: input.planType,
      fixedFeeMinor: input.fixedFeeMinor !== undefined ? BigInt(input.fixedFeeMinor) : undefined,
      fixedFeeCurrency: input.fixedFeeCurrency,
      billingCycle: input.billingCycle,
    });
    return toBillingPlanResponse(plan);
  }
}

function requireTenant(): { restaurantId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId };
}

/** No @RequirePermission/role-seed for this: a super-admin token already
 * bypasses PermissionGuard entirely, and these routes must never be
 * reachable by anyone else — including an Owner, same reasoning as
 * FeatureFlagsController's own requireSuperAdmin. */
function requireSuperAdmin(): { userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  if (!tenant.isSuperAdmin) {
    throw new ForbiddenException("Super admin access required");
  }
  return { userId: tenant.userId };
}
