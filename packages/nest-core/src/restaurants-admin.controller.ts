import { Body, Controller, ForbiddenException, Get, Param, Put, Query, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import {
  ListAuditLogsQuerySchema,
  SetRestaurantStatusSchema,
  type AuditLogPage,
  type RestaurantDetail,
  type RestaurantSummary,
} from "@mezbaan/contracts";
import { AuditLogService, type AuditLogRecord } from "./audit-log.service.js";
import {
  RestaurantsAdminService,
  type RestaurantDetailRecord,
  type RestaurantSummaryRecord,
} from "./restaurants-admin.service.js";
import { getTenantContext } from "./tenant-context.js";
import { parseOrBadRequest } from "./validation.js";

const RestaurantIdParamSchema = z.object({ restaurantId: z.string().uuid() });

function toAuditLogResponse(entry: AuditLogRecord) {
  return {
    id: entry.id,
    restaurantId: entry.restaurantId,
    branchId: entry.branchId,
    actorUserId: entry.actorUserId,
    deviceId: entry.deviceId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    metadata: entry.metadata as Record<string, unknown> | null,
    actingAsSuperAdmin: entry.actingAsSuperAdmin,
    createdAt: entry.createdAt.toISOString(),
  };
}

function toSummaryResponse(restaurant: RestaurantSummaryRecord): RestaurantSummary {
  return {
    id: restaurant.id,
    name: restaurant.name,
    slug: restaurant.slug,
    status: restaurant.status,
    branchCount: restaurant.branchCount,
    deviceCount: restaurant.deviceCount,
    billingPlan: {
      planType: restaurant.billingPlan.planType,
      fixedFeeMinor: restaurant.billingPlan.fixedFeeMinor?.toString() ?? null,
      fixedFeeCurrency: restaurant.billingPlan.fixedFeeCurrency,
      billingCycle: restaurant.billingPlan.billingCycle,
    },
    createdAt: restaurant.createdAt.toISOString(),
  };
}

function toDetailResponse(restaurant: RestaurantDetailRecord): RestaurantDetail {
  return {
    ...toSummaryResponse(restaurant),
    branches: restaurant.branches,
    devices: restaurant.devices.map((device) => ({
      id: device.id,
      branchId: device.branchId,
      label: device.label,
      deviceType: device.deviceType,
      status: device.status,
      lastSeenAt: device.lastSeenAt ? device.lastSeenAt.toISOString() : null,
    })),
    outstandingSettlements: restaurant.outstandingSettlements.map((entry) => ({
      currency: entry.currency,
      remainingAmountMinor: entry.remainingAmountMinor.toString(),
    })),
  };
}

/** P3-39: Super Admin's restaurant list, support-tool detail lookup and
 * status control — every route here is super-admin-only, same
 * requireSuperAdmin split as FeatureFlagsController/BillingPlanController. */
@Controller("restaurants")
export class RestaurantsAdminController {
  constructor(
    private readonly restaurantsAdminService: RestaurantsAdminService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get()
  async list(): Promise<RestaurantSummary[]> {
    requireSuperAdmin();
    const restaurants = await this.restaurantsAdminService.list();
    return restaurants.map(toSummaryResponse);
  }

  @Get(":restaurantId")
  async getDetail(@Param() params: unknown): Promise<RestaurantDetail> {
    requireSuperAdmin();
    const { restaurantId } = parseOrBadRequest(RestaurantIdParamSchema, params);
    const detail = await this.restaurantsAdminService.getDetail(restaurantId);
    return toDetailResponse(detail);
  }

  @Put(":restaurantId/status")
  async setStatus(@Param() params: unknown, @Body() body: unknown): Promise<RestaurantSummary> {
    const actor = requireSuperAdmin();
    const { restaurantId } = parseOrBadRequest(RestaurantIdParamSchema, params);
    const { status } = parseOrBadRequest(SetRestaurantStatusSchema, body);
    await this.restaurantsAdminService.setStatus({ restaurantId, actorUserId: actor.userId, status });
    const updated = await this.restaurantsAdminService.getSummary(restaurantId);
    return toSummaryResponse(updated);
  }

  /** P3-40: the full audit trail for one restaurant, including every entry's
   * own `actingAsSuperAdmin` flag — this IS the "clear visible notice"
   * primitive, not a separate mechanism. */
  @Get(":restaurantId/audit-logs")
  async listAuditLogs(@Param() params: unknown, @Query() query: unknown): Promise<AuditLogPage> {
    requireSuperAdmin();
    const { restaurantId } = parseOrBadRequest(RestaurantIdParamSchema, params);
    const { cursor, limit } = parseOrBadRequest(ListAuditLogsQuerySchema, query);
    const page = await this.auditLogService.listForRestaurantAsSuperAdmin({ restaurantId, cursor, limit });
    return { items: page.items.map(toAuditLogResponse), nextCursor: page.nextCursor };
  }
}

/** No @RequirePermission/role-seed for this: a super-admin token already
 * bypasses PermissionGuard entirely, and these routes must never be
 * reachable by anyone else — including an Owner, same reasoning as every
 * other super-admin-only controller in this codebase. */
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
