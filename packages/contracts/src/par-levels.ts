import { z } from "zod";

export const SetParLevelSchema = z
  .object({
    storageLocationId: z.string().uuid(),
    itemId: z.string().uuid(),
    minQuantity: z.number().min(0),
    parQuantity: z.number().min(0),
  })
  .refine((data) => data.parQuantity >= data.minQuantity, {
    message: "parQuantity must be greater than or equal to minQuantity",
    path: ["parQuantity"],
  });
export type SetParLevel = z.infer<typeof SetParLevelSchema>;

export const ItemParLevelSchema = z.object({
  id: z.string().uuid(),
  storageLocationId: z.string().uuid(),
  itemId: z.string().uuid(),
  minQuantity: z.number(),
  parQuantity: z.number(),
  updatedByUserId: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ItemParLevel = z.infer<typeof ItemParLevelSchema>;

export const ListParLevelsQuerySchema = z.object({
  storageLocationId: z.string().uuid().optional(),
  itemId: z.string().uuid().optional(),
});
export type ListParLevelsQuery = z.infer<typeof ListParLevelsQuerySchema>;

export const LowStockItemSchema = z.object({
  storageLocationId: z.string().uuid(),
  itemId: z.string().uuid(),
  quantity: z.number(),
  minQuantity: z.number(),
  parQuantity: z.number(),
});
export type LowStockItem = z.infer<typeof LowStockItemSchema>;

export const ListLowStockQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  storageLocationId: z.string().uuid().optional(),
});
export type ListLowStockQuery = z.infer<typeof ListLowStockQuerySchema>;
