import { Controller, Get, Query, UnauthorizedException } from "@nestjs/common";
import { DailyReportQuerySchema, type PrepTimeReport } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { KitchenPrepTimeReportsService } from "./kitchen-prep-time-reports.service.js";
import { parseOrBadRequest } from "./validation.js";

/** P3-06: same branch/business-day scoping and reports.view permission as
 * SalesReportsController (P2-40) — lives in api-reports, same failure
 * boundary ("api-reports fails → selling and stock continue, reports are
 * delayed"). */
@Controller("reports/kitchen")
export class KitchenPrepTimeReportsController {
  constructor(private readonly kitchenPrepTimeReportsService: KitchenPrepTimeReportsService) {}

  @Get("prep-time")
  @RequirePermission("reports.view")
  async getPrepTimeReport(@Query() query: unknown): Promise<PrepTimeReport> {
    const tenant = requireTenant();
    const { branchId, businessDate } = parseOrBadRequest(DailyReportQuerySchema, query);
    return this.kitchenPrepTimeReportsService.getReport({ restaurantId: tenant.restaurantId, branchId, businessDate });
  }
}

function requireTenant(): { restaurantId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId };
}
