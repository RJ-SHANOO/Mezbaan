import { z } from "zod";
import { StockMovementSchema } from "./stock-ledger.js";

export const RecordProductionBatchSchema = z.object({
  semiFinishedItemId: z.string().uuid(),
  batchQuantity: z.number().positive(),
  consumptionStorageLocationId: z.string().uuid(),
  outputStorageLocationId: z.string().uuid(),
  note: z.string().min(1).optional(),
});
export type RecordProductionBatch = z.infer<typeof RecordProductionBatchSchema>;

export const ProductionBatchResultSchema = z.object({
  productionBatchId: z.string().uuid(),
  consumed: z.array(StockMovementSchema),
  produced: StockMovementSchema,
});
export type ProductionBatchResult = z.infer<typeof ProductionBatchResultSchema>;
