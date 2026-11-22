import { z } from "zod";

const MINOR_UNITS_PATTERN = /^-?\d+$/;
const MinorUnitsSchema = z.string().regex(MINOR_UNITS_PATTERN, "must be an integer string");

export const StockLevelSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  storageLocationId: z.string().uuid(),
  itemId: z.string().uuid(),
  quantity: z.number(),
  averageCostMinor: MinorUnitsSchema.nullable(),
  currency: z.string().nullable(),
  updatedAt: z.string(),
});
export type StockLevel = z.infer<typeof StockLevelSchema>;

export const ListStockLevelsQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  storageLocationId: z.string().uuid().optional(),
  itemId: z.string().uuid().optional(),
});
export type ListStockLevelsQuery = z.infer<typeof ListStockLevelsQuerySchema>;

export const RebuildStockLevelsSchema = z.object({
  branchId: z.string().uuid().optional(),
  apply: z.boolean().optional(),
});
export type RebuildStockLevels = z.infer<typeof RebuildStockLevelsSchema>;

export const StockLevelDiscrepancySchema = z.object({
  branchId: z.string().uuid(),
  storageLocationId: z.string().uuid(),
  itemId: z.string().uuid(),
  storedQuantity: z.number(),
  actualQuantity: z.number(),
  storedCostMinor: MinorUnitsSchema.nullable(),
  actualCostMinor: MinorUnitsSchema.nullable(),
  currency: z.string().nullable(),
});
export type StockLevelDiscrepancy = z.infer<typeof StockLevelDiscrepancySchema>;

export const RebuildStockLevelsResultSchema = z.object({
  checked: z.number().int(),
  discrepancies: z.array(StockLevelDiscrepancySchema),
  applied: z.boolean(),
});
export type RebuildStockLevelsResult = z.infer<typeof RebuildStockLevelsResultSchema>;
