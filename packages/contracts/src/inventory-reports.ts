import { z } from "zod";
import { MovementTypeSchema } from "./stock-ledger.js";

const BusinessDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const MINOR_UNITS_PATTERN = /^-?\d+$/;
const MinorUnitsSchema = z.string().regex(MINOR_UNITS_PATTERN, "must be an integer string");

export const StockOnHandQuerySchema = z.object({
  branchId: z.string().uuid(),
  storageLocationId: z.string().uuid().optional(),
});
export type StockOnHandQuery = z.infer<typeof StockOnHandQuerySchema>;

export const StockOnHandEntrySchema = z.object({
  storageLocationId: z.string().uuid(),
  itemId: z.string().uuid(),
  quantity: z.number(),
  averageCostMinor: MinorUnitsSchema.nullable(),
  currency: z.string().nullable(),
  valueMinor: MinorUnitsSchema.nullable(),
});
export type StockOnHandEntry = z.infer<typeof StockOnHandEntrySchema>;

export const StockOnHandReportSchema = z.object({
  branchId: z.string().uuid(),
  entries: z.array(StockOnHandEntrySchema),
  currency: z.string().nullable(),
  totalValueMinor: MinorUnitsSchema,
});
export type StockOnHandReport = z.infer<typeof StockOnHandReportSchema>;

export const StockValuationQuerySchema = z.object({
  branchId: z.string().uuid(),
});
export type StockValuationQuery = z.infer<typeof StockValuationQuerySchema>;

export const StockValuationByLocationSchema = z.object({
  storageLocationId: z.string().uuid(),
  valueMinor: MinorUnitsSchema,
});
export type StockValuationByLocation = z.infer<typeof StockValuationByLocationSchema>;

export const StockValuationReportSchema = z.object({
  branchId: z.string().uuid(),
  currency: z.string().nullable(),
  byLocation: z.array(StockValuationByLocationSchema),
  totalValueMinor: MinorUnitsSchema,
});
export type StockValuationReport = z.infer<typeof StockValuationReportSchema>;

export const StockMovementReportQuerySchema = z.object({
  branchId: z.string().uuid(),
  fromBusinessDate: BusinessDateSchema,
  toBusinessDate: BusinessDateSchema,
});
export type StockMovementReportQuery = z.infer<typeof StockMovementReportQuerySchema>;

export const StockMovementSummaryEntrySchema = z.object({
  movementType: MovementTypeSchema,
  count: z.number().int(),
  totalQuantityDelta: z.number(),
});
export type StockMovementSummaryEntry = z.infer<typeof StockMovementSummaryEntrySchema>;

export const StockMovementReportSchema = z.object({
  branchId: z.string().uuid(),
  fromBusinessDate: BusinessDateSchema,
  toBusinessDate: BusinessDateSchema,
  byMovementType: z.array(StockMovementSummaryEntrySchema),
});
export type StockMovementReport = z.infer<typeof StockMovementReportSchema>;

export const FoodCostVarianceReportQuerySchema = z.object({
  branchId: z.string().uuid(),
  fromBusinessDate: BusinessDateSchema,
  toBusinessDate: BusinessDateSchema,
});
export type FoodCostVarianceReportQuery = z.infer<typeof FoodCostVarianceReportQuerySchema>;

export const FoodCostVarianceReportSchema = z.object({
  branchId: z.string().uuid(),
  fromBusinessDate: BusinessDateSchema,
  toBusinessDate: BusinessDateSchema,
  currency: z.string().nullable(),
  theoreticalCostMinor: MinorUnitsSchema,
  actualSalesCostMinor: MinorUnitsSchema,
  actualWastageCostMinor: MinorUnitsSchema,
  actualCostMinor: MinorUnitsSchema,
  varianceMinor: MinorUnitsSchema,
});
export type FoodCostVarianceReport = z.infer<typeof FoodCostVarianceReportSchema>;

export const BranchDateRangeQuerySchema = z.object({
  branchId: z.string().uuid(),
  fromBusinessDate: BusinessDateSchema,
  toBusinessDate: BusinessDateSchema,
});
export type BranchDateRangeQuery = z.infer<typeof BranchDateRangeQuerySchema>;

export const WastageReportByReasonEntrySchema = z.object({
  reasonCode: z.string(),
  count: z.number().int(),
  costMinor: MinorUnitsSchema,
});
export type WastageReportByReasonEntry = z.infer<typeof WastageReportByReasonEntrySchema>;

export const WastageReportSchema = z.object({
  branchId: z.string().uuid(),
  fromBusinessDate: BusinessDateSchema,
  toBusinessDate: BusinessDateSchema,
  currency: z.string().nullable(),
  totalCostMinor: MinorUnitsSchema,
  byReasonCode: z.array(WastageReportByReasonEntrySchema),
});
export type WastageReport = z.infer<typeof WastageReportSchema>;

export const PurchaseReportBySupplierEntrySchema = z.object({
  supplierId: z.string().uuid(),
  valueMinor: MinorUnitsSchema,
  noteCount: z.number().int(),
});
export type PurchaseReportBySupplierEntry = z.infer<typeof PurchaseReportBySupplierEntrySchema>;

export const PurchaseReportSchema = z.object({
  branchId: z.string().uuid(),
  fromBusinessDate: BusinessDateSchema,
  toBusinessDate: BusinessDateSchema,
  currency: z.string().nullable(),
  totalValueMinor: MinorUnitsSchema,
  bySupplier: z.array(PurchaseReportBySupplierEntrySchema),
});
export type PurchaseReport = z.infer<typeof PurchaseReportSchema>;

export const SupplierActivityReportQuerySchema = z.object({
  supplierId: z.string().uuid(),
  fromBusinessDate: BusinessDateSchema,
  toBusinessDate: BusinessDateSchema,
});
export type SupplierActivityReportQuery = z.infer<typeof SupplierActivityReportQuerySchema>;

export const SupplierActivityReportSchema = z.object({
  supplierId: z.string().uuid(),
  fromBusinessDate: BusinessDateSchema,
  toBusinessDate: BusinessDateSchema,
  currency: z.string().nullable(),
  purchasedValueMinor: MinorUnitsSchema,
  goodsReceivedNoteCount: z.number().int(),
  returnedQuantity: z.number(),
  purchaseReturnCount: z.number().int(),
});
export type SupplierActivityReport = z.infer<typeof SupplierActivityReportSchema>;
