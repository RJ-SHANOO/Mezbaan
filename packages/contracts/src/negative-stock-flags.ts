import { z } from "zod";
import { pageResponseSchema } from "./pagination.js";

export const NegativeStockFlagSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  storageLocationId: z.string().uuid(),
  itemId: z.string().uuid(),
  stockLedgerId: z.string().uuid(),
  quantityAfter: z.number(),
  reviewedAt: z.string().nullable(),
  reviewedByUserId: z.string().uuid().nullable(),
  createdAt: z.string(),
});
export type NegativeStockFlag = z.infer<typeof NegativeStockFlagSchema>;

export const ListNegativeStockFlagsQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  reviewed: z.coerce.boolean().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListNegativeStockFlagsQuery = z.infer<typeof ListNegativeStockFlagsQuerySchema>;

export const NegativeStockFlagPageSchema = pageResponseSchema(NegativeStockFlagSchema);
export type NegativeStockFlagPage = z.infer<typeof NegativeStockFlagPageSchema>;
