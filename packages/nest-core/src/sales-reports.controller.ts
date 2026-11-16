import { Controller, Get, Query, UnauthorizedException } from "@nestjs/common";
import { DailyReportQuerySchema, type DailySalesSummary, type DiscountReport, type PaymentBreakdown, type RefundReport, type VoidReport } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { SalesReportsService } from "./sales-reports.service.js";
import { parseOrBadRequest } from "./validation.js";

function toMinorStrings<T extends Record<string, unknown>>(obj: T): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).map(([key, value]) => [key, String(value)]));
}

/** P2-40: basic pilot reports, each scoped to one branch's business day.
 * Lives in api-reports (rule: "api-reports fails → selling and stock
 * continue; reports are delayed") — a separate process from the ones that
 * actually record a sale, so a slow or broken report can never hold one
 * up. All five routes share the same reports.view permission (already
 * seeded, already granted to branch_manager/owner/super_admin). */
@Controller("reports")
export class SalesReportsController {
  constructor(private readonly salesReportsService: SalesReportsService) {}

  @Get("daily-summary")
  @RequirePermission("reports.view")
  async getDailySummary(@Query() query: unknown): Promise<DailySalesSummary> {
    const tenant = requireTenant();
    const { branchId, businessDate } = parseOrBadRequest(DailyReportQuerySchema, query);
    const summary = await this.salesReportsService.getDailySummary({ restaurantId: tenant.restaurantId, branchId, businessDate });
    return {
      businessDate: summary.businessDate,
      currency: summary.currency,
      orderCount: summary.orderCount,
      subtotalMinor: summary.subtotalMinor.toString(),
      taxMinor: summary.taxMinor.toString(),
      serviceChargeMinor: summary.serviceChargeMinor.toString(),
      grossSalesMinor: summary.grossSalesMinor.toString(),
    };
  }

  @Get("payment-breakdown")
  @RequirePermission("reports.view")
  async getPaymentBreakdown(@Query() query: unknown): Promise<PaymentBreakdown> {
    const tenant = requireTenant();
    const { branchId, businessDate } = parseOrBadRequest(DailyReportQuerySchema, query);
    const breakdown = await this.salesReportsService.getPaymentBreakdown({ restaurantId: tenant.restaurantId, branchId, businessDate });
    return {
      ...breakdown,
      byMethod: toMinorStrings(breakdown.byMethod) as PaymentBreakdown["byMethod"],
      tipsMinor: breakdown.tipsMinor.toString(),
      totalMinor: breakdown.totalMinor.toString(),
    };
  }

  @Get("voids")
  @RequirePermission("reports.view")
  async getVoidReport(@Query() query: unknown): Promise<VoidReport> {
    const tenant = requireTenant();
    const { branchId, businessDate } = parseOrBadRequest(DailyReportQuerySchema, query);
    const report = await this.salesReportsService.getVoidReport({ restaurantId: tenant.restaurantId, branchId, businessDate });
    return {
      ...report,
      totalValueMinor: report.totalValueMinor.toString(),
      entries: report.entries.map((entry) => ({ ...entry, valueMinor: entry.valueMinor.toString(), voidedAt: entry.voidedAt.toISOString() })),
    };
  }

  @Get("discounts")
  @RequirePermission("reports.view")
  async getDiscountReport(@Query() query: unknown): Promise<DiscountReport> {
    const tenant = requireTenant();
    const { branchId, businessDate } = parseOrBadRequest(DailyReportQuerySchema, query);
    const report = await this.salesReportsService.getDiscountReport({ restaurantId: tenant.restaurantId, branchId, businessDate });
    return {
      ...report,
      totalDiscountMinor: report.totalDiscountMinor.toString(),
      entries: report.entries.map((entry) => ({ ...entry, discountMinor: entry.discountMinor.toString() })),
    };
  }

  @Get("refunds")
  @RequirePermission("reports.view")
  async getRefundReport(@Query() query: unknown): Promise<RefundReport> {
    const tenant = requireTenant();
    const { branchId, businessDate } = parseOrBadRequest(DailyReportQuerySchema, query);
    const report = await this.salesReportsService.getRefundReport({ restaurantId: tenant.restaurantId, branchId, businessDate });
    return {
      ...report,
      totalRefundedMinor: report.totalRefundedMinor.toString(),
      entries: report.entries.map((entry) => ({ ...entry, amountMinor: entry.amountMinor.toString(), createdAt: entry.createdAt.toISOString() })),
    };
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
