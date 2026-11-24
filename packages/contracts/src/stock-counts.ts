import { z } from "zod";
import { pageResponseSchema } from "./pagination.js";
import { StockMovementSchema } from "./stock-ledger.js";

export const StockCountTypeSchema = z.enum(["full", "cycle"]);
export type StockCountType = z.infer<typeof StockCountTypeSchema>;

export const StockCountStatusSchema = z.enum(["in_progress", "submitted", "approved"]);
export type StockCountStatus = z.infer<typeof StockCountStatusSchema>;

export const StartStockCountSchema = z
  .object({
    branchId: z.string().uuid(),
    storageLocationId: z.string().uuid(),
    countType: StockCountTypeSchema,
    itemIds: z.array(z.string().uuid()).min(1).optional(),
    note: z.string().min(1).optional(),
  })
  .refine((data) => data.countType !== "cycle" || (data.itemIds !== undefined && data.itemIds.length > 0), {
    message: "itemIds is required for a cycle count",
    path: ["itemIds"],
  });
export type StartStockCount = z.infer<typeof StartStockCountSchema>;

export const SubmitStockCountLineSchema = z.object({
  countedQuantity: z.number().min(0),
});
export type SubmitStockCountLine = z.infer<typeof SubmitStockCountLineSchema>;

export const StockCountItemSchema = z.object({
  id: z.string().uuid(),
  itemId: z.string().uuid(),
  expectedQuantity: z.number().nullable(),
  countedQuantity: z.number().nullable(),
  countedAt: z.string().nullable(),
  countedByUserId: z.string().uuid().nullable(),
});
export type StockCountItem = z.infer<typeof StockCountItemSchema>;

export const StockCountSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  storageLocationId: z.string().uuid(),
  countType: StockCountTypeSchema,
  status: StockCountStatusSchema,
  startedByUserId: z.string().uuid(),
  submittedAt: z.string().nullable(),
  approvedByUserId: z.string().uuid().nullable(),
  approvedAt: z.string().nullable(),
  note: z.string().nullable(),
  items: z.array(StockCountItemSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StockCount = z.infer<typeof StockCountSchema>;

export const ApproveStockCountSchema = z.object({
  managerUserId: z.string().uuid(),
  managerPin: z.string().min(1),
});
export type ApproveStockCount = z.infer<typeof ApproveStockCountSchema>;

export const ApproveStockCountResultSchema = z.object({
  stockCount: StockCountSchema,
  adjustments: z.array(StockMovementSchema),
});
export type ApproveStockCountResult = z.infer<typeof ApproveStockCountResultSchema>;

export const StockCountSummarySchema = StockCountSchema.omit({ items: true });
export type StockCountSummary = z.infer<typeof StockCountSummarySchema>;

export const ListStockCountsQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  storageLocationId: z.string().uuid().optional(),
  status: StockCountStatusSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListStockCountsQuery = z.infer<typeof ListStockCountsQuerySchema>;

export const StockCountSummaryPageSchema = pageResponseSchema(StockCountSummarySchema);
export type StockCountSummaryPage = z.infer<typeof StockCountSummaryPageSchema>;
