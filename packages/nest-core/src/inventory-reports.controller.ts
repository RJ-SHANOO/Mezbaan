import { Controller, Get, Query, UnauthorizedException } from "@nestjs/common";
import {
  BranchDateRangeQuerySchema,
  FoodCostVarianceReportQuerySchema,
  StockMovementReportQuerySchema,
  StockOnHandQuerySchema,
  StockValuationQuerySchema,
  SupplierActivityReportQuerySchema,
  type FoodCostVarianceReport,
  type PurchaseReport,
  type StockMovementReport,
  type StockOnHandReport,
  type StockValuationReport,
  type SupplierActivityReport,
  type WastageReport,
} from "@mezbaan/contracts";
import { ReportJobName } from "./report-job-names.js";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { ReportsQueueService } from "./reports-queue.service.js";
import { parseOrBadRequest } from "./validation.js";

/** P3-31: stock on hand, valuation and movement reports — lives in
 * api-reports, same process-boundary reasoning as SalesReportsController
 * (P2-40). Shares the same reports.view permission.
 *
 * P3-43: each one now runs through ReportsQueueService — see
 * SalesReportsController's own docs for the full reasoning; the response
 * mapping that used to happen right here now lives in
 * ReportJobHandlersProvider (apps/api-reports). */
@Controller("reports/inventory")
export class InventoryReportsController {
  constructor(private readonly reportsQueueService: ReportsQueueService) {}

  @Get("stock-on-hand")
  @RequirePermission("reports.view")
  async getStockOnHand(@Query() query: unknown): Promise<StockOnHandReport> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(StockOnHandQuerySchema, query);
    return this.reportsQueueService.run(ReportJobName.InventoryStockOnHand, { restaurantId: tenant.restaurantId, ...request });
  }

  @Get("stock-valuation")
  @RequirePermission("reports.view")
  async getStockValuation(@Query() query: unknown): Promise<StockValuationReport> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(StockValuationQuerySchema, query);
    return this.reportsQueueService.run(ReportJobName.InventoryStockValuation, { restaurantId: tenant.restaurantId, ...request });
  }

  @Get("stock-movement")
  @RequirePermission("reports.view")
  async getStockMovementReport(@Query() query: unknown): Promise<StockMovementReport> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(StockMovementReportQuerySchema, query);
    return this.reportsQueueService.run(ReportJobName.InventoryStockMovement, { restaurantId: tenant.restaurantId, ...request });
  }

  @Get("food-cost-variance")
  @RequirePermission("reports.view")
  async getFoodCostVarianceReport(@Query() query: unknown): Promise<FoodCostVarianceReport> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(FoodCostVarianceReportQuerySchema, query);
    return this.reportsQueueService.run(ReportJobName.InventoryFoodCostVariance, { restaurantId: tenant.restaurantId, ...request });
  }

  @Get("wastage")
  @RequirePermission("reports.view")
  async getWastageReport(@Query() query: unknown): Promise<WastageReport> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(BranchDateRangeQuerySchema, query);
    return this.reportsQueueService.run(ReportJobName.InventoryWastage, { restaurantId: tenant.restaurantId, ...request });
  }

  @Get("purchases")
  @RequirePermission("reports.view")
  async getPurchaseReport(@Query() query: unknown): Promise<PurchaseReport> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(BranchDateRangeQuerySchema, query);
    return this.reportsQueueService.run(ReportJobName.InventoryPurchases, { restaurantId: tenant.restaurantId, ...request });
  }

  @Get("supplier-activity")
  @RequirePermission("reports.view")
  async getSupplierActivityReport(@Query() query: unknown): Promise<SupplierActivityReport> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(SupplierActivityReportQuerySchema, query);
    return this.reportsQueueService.run(ReportJobName.InventorySupplierActivity, { restaurantId: tenant.restaurantId, ...request });
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
