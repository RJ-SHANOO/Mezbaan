import { Controller, Get, Query, UnauthorizedException } from "@nestjs/common";
import { DailyReportQuerySchema, type DailySalesSummary, type DiscountReport, type PaymentBreakdown, type RefundReport, type VoidReport } from "@mezbaan/contracts";
import { ReportJobName } from "./report-job-names.js";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { ReportsQueueService } from "./reports-queue.service.js";
import { parseOrBadRequest } from "./validation.js";

/** P2-40: basic pilot reports, each scoped to one branch's business day.
 * Lives in api-reports (rule: "api-reports fails → selling and stock
 * continue; reports are delayed") — a separate process from the ones that
 * actually record a sale, so a slow or broken report can never hold one
 * up. All five routes share the same reports.view permission (already
 * seeded, already granted to branch_manager/owner/super_admin).
 *
 * P3-43: each one now runs through ReportsQueueService (a BullMQ job with
 * its own bounded concurrency) rather than computing inline here — the
 * response shape and every error this already returned (400 from
 * `parseOrBadRequest` below, same as always; anything the report service
 * itself throws, round-tripped through the queue unchanged) are both
 * identical to before. The actual mapping from each service's own result
 * to this wire shape now lives in ReportJobHandlersProvider
 * (apps/api-reports), since that's what runs inside the job. */
@Controller("reports")
export class SalesReportsController {
  constructor(private readonly reportsQueueService: ReportsQueueService) {}

  @Get("daily-summary")
  @RequirePermission("reports.view")
  async getDailySummary(@Query() query: unknown): Promise<DailySalesSummary> {
    const tenant = requireTenant();
    const { branchId, businessDate } = parseOrBadRequest(DailyReportQuerySchema, query);
    return this.reportsQueueService.run(ReportJobName.SalesDailySummary, { restaurantId: tenant.restaurantId, branchId, businessDate });
  }

  @Get("payment-breakdown")
  @RequirePermission("reports.view")
  async getPaymentBreakdown(@Query() query: unknown): Promise<PaymentBreakdown> {
    const tenant = requireTenant();
    const { branchId, businessDate } = parseOrBadRequest(DailyReportQuerySchema, query);
    return this.reportsQueueService.run(ReportJobName.SalesPaymentBreakdown, { restaurantId: tenant.restaurantId, branchId, businessDate });
  }

  @Get("voids")
  @RequirePermission("reports.view")
  async getVoidReport(@Query() query: unknown): Promise<VoidReport> {
    const tenant = requireTenant();
    const { branchId, businessDate } = parseOrBadRequest(DailyReportQuerySchema, query);
    return this.reportsQueueService.run(ReportJobName.SalesVoidReport, { restaurantId: tenant.restaurantId, branchId, businessDate });
  }

  @Get("discounts")
  @RequirePermission("reports.view")
  async getDiscountReport(@Query() query: unknown): Promise<DiscountReport> {
    const tenant = requireTenant();
    const { branchId, businessDate } = parseOrBadRequest(DailyReportQuerySchema, query);
    return this.reportsQueueService.run(ReportJobName.SalesDiscountReport, { restaurantId: tenant.restaurantId, branchId, businessDate });
  }

  @Get("refunds")
  @RequirePermission("reports.view")
  async getRefundReport(@Query() query: unknown): Promise<RefundReport> {
    const tenant = requireTenant();
    const { branchId, businessDate } = parseOrBadRequest(DailyReportQuerySchema, query);
    return this.reportsQueueService.run(ReportJobName.SalesRefundReport, { restaurantId: tenant.restaurantId, branchId, businessDate });
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
