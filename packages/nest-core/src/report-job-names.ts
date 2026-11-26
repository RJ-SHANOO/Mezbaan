/** P3-43: one BullMQ job name per report endpoint — the single source of
 * truth both the controllers below (which enqueue) and
 * apps/api-reports/ReportJobHandlersProvider (which registers what
 * actually computes each one) share, so the two can never drift apart. */
export const ReportJobName = {
  SalesDailySummary: "sales.daily-summary",
  SalesPaymentBreakdown: "sales.payment-breakdown",
  SalesVoidReport: "sales.void-report",
  SalesDiscountReport: "sales.discount-report",
  SalesRefundReport: "sales.refund-report",
  KitchenPrepTime: "kitchen.prep-time",
  InventoryStockOnHand: "inventory.stock-on-hand",
  InventoryStockValuation: "inventory.stock-valuation",
  InventoryStockMovement: "inventory.stock-movement",
  InventoryFoodCostVariance: "inventory.food-cost-variance",
  InventoryWastage: "inventory.wastage",
  InventoryPurchases: "inventory.purchases",
  InventorySupplierActivity: "inventory.supplier-activity",
} as const;
