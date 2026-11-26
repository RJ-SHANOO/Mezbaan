import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import type {
  DailySalesSummary,
  DiscountReport,
  FoodCostVarianceReport,
  PaymentBreakdown,
  PrepTimeReport,
  PurchaseReport,
  RefundReport,
  StockMovementReport,
  StockOnHandReport,
  StockValuationReport,
  SupplierActivityReport,
  VoidReport,
  WastageReport,
} from "@mezbaan/contracts";
import { InventoryReportsService, KitchenPrepTimeReportsService, ReportJobName, ReportsQueueService, SalesReportsService } from "@mezbaan/nest-core";

function toMinorStrings<T extends Record<string, unknown>>(obj: T): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).map(([key, value]) => [key, String(value)]));
}

/**
 * P3-43: registers every report's real computation against its own
 * BullMQ job name — the exact same service calls and response-shape
 * mapping each controller used to do directly, just invoked from inside
 * ReportsQueueService's worker instead. Mirrors ReconciliationHandlerProvider/
 * CommissionHandlerProvider's own shape (apps/worker) — register-at-
 * onModuleInit, nothing fancier.
 */
@Injectable()
export class ReportJobHandlersProvider implements OnModuleInit {
  constructor(
    @Inject(ReportsQueueService) private readonly reportsQueueService: ReportsQueueService,
    @Inject(SalesReportsService) private readonly salesReportsService: SalesReportsService,
    @Inject(InventoryReportsService) private readonly inventoryReportsService: InventoryReportsService,
    @Inject(KitchenPrepTimeReportsService) private readonly kitchenPrepTimeReportsService: KitchenPrepTimeReportsService,
  ) {}

  onModuleInit(): void {
    this.reportsQueueService.registerHandler(ReportJobName.SalesDailySummary, async (params: { restaurantId: string; branchId: string; businessDate: string }): Promise<DailySalesSummary> => {
      const summary = await this.salesReportsService.getDailySummary(params);
      return {
        businessDate: summary.businessDate,
        currency: summary.currency,
        orderCount: summary.orderCount,
        subtotalMinor: summary.subtotalMinor.toString(),
        taxMinor: summary.taxMinor.toString(),
        serviceChargeMinor: summary.serviceChargeMinor.toString(),
        grossSalesMinor: summary.grossSalesMinor.toString(),
      };
    });

    this.reportsQueueService.registerHandler(ReportJobName.SalesPaymentBreakdown, async (params: { restaurantId: string; branchId: string; businessDate: string }): Promise<PaymentBreakdown> => {
      const breakdown = await this.salesReportsService.getPaymentBreakdown(params);
      return {
        ...breakdown,
        byMethod: toMinorStrings(breakdown.byMethod) as PaymentBreakdown["byMethod"],
        tipsMinor: breakdown.tipsMinor.toString(),
        totalMinor: breakdown.totalMinor.toString(),
      };
    });

    this.reportsQueueService.registerHandler(ReportJobName.SalesVoidReport, async (params: { restaurantId: string; branchId: string; businessDate: string }): Promise<VoidReport> => {
      const report = await this.salesReportsService.getVoidReport(params);
      return {
        ...report,
        totalValueMinor: report.totalValueMinor.toString(),
        entries: report.entries.map((entry) => ({ ...entry, valueMinor: entry.valueMinor.toString(), voidedAt: entry.voidedAt.toISOString() })),
      };
    });

    this.reportsQueueService.registerHandler(ReportJobName.SalesDiscountReport, async (params: { restaurantId: string; branchId: string; businessDate: string }): Promise<DiscountReport> => {
      const report = await this.salesReportsService.getDiscountReport(params);
      return {
        ...report,
        totalDiscountMinor: report.totalDiscountMinor.toString(),
        entries: report.entries.map((entry) => ({ ...entry, discountMinor: entry.discountMinor.toString() })),
      };
    });

    this.reportsQueueService.registerHandler(ReportJobName.SalesRefundReport, async (params: { restaurantId: string; branchId: string; businessDate: string }): Promise<RefundReport> => {
      const report = await this.salesReportsService.getRefundReport(params);
      return {
        ...report,
        totalRefundedMinor: report.totalRefundedMinor.toString(),
        entries: report.entries.map((entry) => ({ ...entry, amountMinor: entry.amountMinor.toString(), createdAt: entry.createdAt.toISOString() })),
      };
    });

    this.reportsQueueService.registerHandler(ReportJobName.KitchenPrepTime, async (params: { restaurantId: string; branchId: string; businessDate: string }): Promise<PrepTimeReport> => {
      return this.kitchenPrepTimeReportsService.getReport(params);
    });

    this.reportsQueueService.registerHandler(ReportJobName.InventoryStockOnHand, async (params: { restaurantId: string; branchId: string; storageLocationId?: string }): Promise<StockOnHandReport> => {
      const report = await this.inventoryReportsService.getStockOnHand(params);
      return {
        branchId: report.branchId,
        currency: report.currency,
        totalValueMinor: report.totalValueMinor.toString(),
        entries: report.entries.map((entry) => ({
          storageLocationId: entry.storageLocationId,
          itemId: entry.itemId,
          quantity: entry.quantity,
          averageCostMinor: entry.averageCostMinor?.toString() ?? null,
          currency: entry.currency,
          valueMinor: entry.valueMinor?.toString() ?? null,
        })),
      };
    });

    this.reportsQueueService.registerHandler(ReportJobName.InventoryStockValuation, async (params: { restaurantId: string; branchId: string }): Promise<StockValuationReport> => {
      const report = await this.inventoryReportsService.getStockValuation(params);
      return {
        branchId: report.branchId,
        currency: report.currency,
        totalValueMinor: report.totalValueMinor.toString(),
        byLocation: report.byLocation.map((entry) => ({ storageLocationId: entry.storageLocationId, valueMinor: entry.valueMinor.toString() })),
      };
    });

    this.reportsQueueService.registerHandler(
      ReportJobName.InventoryStockMovement,
      async (params: { restaurantId: string; branchId: string; fromBusinessDate: string; toBusinessDate: string }): Promise<StockMovementReport> => {
        return this.inventoryReportsService.getStockMovementReport(params);
      },
    );

    this.reportsQueueService.registerHandler(
      ReportJobName.InventoryFoodCostVariance,
      async (params: { restaurantId: string; branchId: string; fromBusinessDate: string; toBusinessDate: string }): Promise<FoodCostVarianceReport> => {
        const report = await this.inventoryReportsService.getFoodCostVarianceReport(params);
        return {
          branchId: report.branchId,
          fromBusinessDate: report.fromBusinessDate,
          toBusinessDate: report.toBusinessDate,
          currency: report.currency,
          theoreticalCostMinor: report.theoreticalCostMinor.toString(),
          actualSalesCostMinor: report.actualSalesCostMinor.toString(),
          actualWastageCostMinor: report.actualWastageCostMinor.toString(),
          actualCostMinor: report.actualCostMinor.toString(),
          varianceMinor: report.varianceMinor.toString(),
        };
      },
    );

    this.reportsQueueService.registerHandler(
      ReportJobName.InventoryWastage,
      async (params: { restaurantId: string; branchId: string; fromBusinessDate: string; toBusinessDate: string }): Promise<WastageReport> => {
        const report = await this.inventoryReportsService.getWastageReport(params);
        return {
          branchId: report.branchId,
          fromBusinessDate: report.fromBusinessDate,
          toBusinessDate: report.toBusinessDate,
          currency: report.currency,
          totalCostMinor: report.totalCostMinor.toString(),
          byReasonCode: report.byReasonCode.map((entry) => ({ reasonCode: entry.reasonCode, count: entry.count, costMinor: entry.costMinor.toString() })),
        };
      },
    );

    this.reportsQueueService.registerHandler(
      ReportJobName.InventoryPurchases,
      async (params: { restaurantId: string; branchId: string; fromBusinessDate: string; toBusinessDate: string }): Promise<PurchaseReport> => {
        const report = await this.inventoryReportsService.getPurchaseReport(params);
        return {
          branchId: report.branchId,
          fromBusinessDate: report.fromBusinessDate,
          toBusinessDate: report.toBusinessDate,
          currency: report.currency,
          totalValueMinor: report.totalValueMinor.toString(),
          bySupplier: report.bySupplier.map((entry) => ({ supplierId: entry.supplierId, valueMinor: entry.valueMinor.toString(), noteCount: entry.noteCount })),
        };
      },
    );

    this.reportsQueueService.registerHandler(
      ReportJobName.InventorySupplierActivity,
      async (params: { restaurantId: string; supplierId: string; fromBusinessDate: string; toBusinessDate: string }): Promise<SupplierActivityReport> => {
        const report = await this.inventoryReportsService.getSupplierActivityReport(params);
        return {
          supplierId: report.supplierId,
          fromBusinessDate: report.fromBusinessDate,
          toBusinessDate: report.toBusinessDate,
          currency: report.currency,
          purchasedValueMinor: report.purchasedValueMinor.toString(),
          goodsReceivedNoteCount: report.goodsReceivedNoteCount,
          returnedQuantity: report.returnedQuantity,
          purchaseReturnCount: report.purchaseReturnCount,
        };
      },
    );
  }
}
