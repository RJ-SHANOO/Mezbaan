import { Controller, Get, Query, UnauthorizedException } from "@nestjs/common";
import { DailyReportQuerySchema, type PrepTimeReport } from "@mezbaan/contracts";
import { ReportJobName } from "./report-job-names.js";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { ReportsQueueService } from "./reports-queue.service.js";
import { parseOrBadRequest } from "./validation.js";

/** P3-06: same branch/business-day scoping and reports.view permission as
 * SalesReportsController (P2-40) — lives in api-reports, same failure
 * boundary ("api-reports fails → selling and stock continue, reports are
 * delayed").
 *
 * P3-43: runs through ReportsQueueService — see SalesReportsController's
 * own docs for the full reasoning. */
@Controller("reports/kitchen")
export class KitchenPrepTimeReportsController {
  constructor(private readonly reportsQueueService: ReportsQueueService) {}

  @Get("prep-time")
  @RequirePermission("reports.view")
  async getPrepTimeReport(@Query() query: unknown): Promise<PrepTimeReport> {
    const tenant = requireTenant();
    const { branchId, businessDate } = parseOrBadRequest(DailyReportQuerySchema, query);
    return this.reportsQueueService.run(ReportJobName.KitchenPrepTime, { restaurantId: tenant.restaurantId, branchId, businessDate });
  }
}

function requireTenant(): { restaurantId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId };
}
