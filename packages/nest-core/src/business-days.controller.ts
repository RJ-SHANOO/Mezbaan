import { Body, Controller, Get, Post, Query, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { BusinessDayStatusQuerySchema, CloseBusinessDaySchema, type BusinessDay, type BusinessDayStatusResponse } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { BusinessDaysService, type BusinessDayRecord } from "./business-days.service.js";
import { parseOrBadRequest } from "./validation.js";

const BranchQuerySchema = z.object({ branchId: z.string().uuid() });

function toBusinessDayResponse(row: BusinessDayRecord): BusinessDay {
  return {
    id: row.id,
    branchId: row.branchId,
    businessDate: row.businessDate,
    status: row.status,
    closedByUserId: row.closedByUserId,
    closedAt: row.closedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** P2-30: closing a branch's business day is a manager-level action, not an
 * ordinary cashier one — gated by the new business_day.manage permission
 * rather than pos.sell, same reasoning the existing manager-approval
 * actions (void/discount/refund) use their own tier instead of pos.sell.
 * Lives in api-pos's OrdersModule since it directly gates OrdersService.create. */
@Controller("business-days")
export class BusinessDaysController {
  constructor(private readonly businessDaysService: BusinessDaysService) {}

  @Post("close")
  @RequirePermission("business_day.manage")
  async close(@Body() body: unknown): Promise<BusinessDay> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(CloseBusinessDaySchema, body);
    const day = await this.businessDaysService.close({ restaurantId: tenant.restaurantId, actorUserId: tenant.userId, branchId: request.branchId, businessDate: request.businessDate });
    return toBusinessDayResponse(day);
  }

  @Get("status")
  @RequirePermission("business_day.manage")
  async getStatus(@Query() query: unknown): Promise<BusinessDayStatusResponse> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(BusinessDayStatusQuerySchema, query);
    return this.businessDaysService.getStatus({ restaurantId: tenant.restaurantId, branchId: request.branchId, businessDate: request.businessDate });
  }

  @Get()
  @RequirePermission("business_day.manage")
  async list(@Query() query: unknown): Promise<BusinessDay[]> {
    const tenant = requireTenant();
    const { branchId } = parseOrBadRequest(BranchQuerySchema, query);
    const days = await this.businessDaysService.list(tenant.restaurantId, branchId);
    return days.map(toBusinessDayResponse);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
