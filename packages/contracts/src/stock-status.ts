import { z } from "zod";

export const MarkOutOfStockSchema = z
  .object({
    branchId: z.string().uuid(),
    productId: z.string().uuid().optional(),
    variantId: z.string().uuid().optional(),
    reason: z.string().min(1).optional(),
  })
  .refine((data) => (data.productId !== undefined) !== (data.variantId !== undefined), {
    message: "exactly one of productId or variantId must be set",
    path: ["productId"],
  });
export type MarkOutOfStock = z.infer<typeof MarkOutOfStockSchema>;

export const ClearOutOfStockQuerySchema = z
  .object({
    branchId: z.string().uuid(),
    productId: z.string().uuid().optional(),
    variantId: z.string().uuid().optional(),
  })
  .refine((data) => (data.productId !== undefined) !== (data.variantId !== undefined), {
    message: "exactly one of productId or variantId must be set",
    path: ["productId"],
  });
export type ClearOutOfStockQuery = z.infer<typeof ClearOutOfStockQuerySchema>;

export const ListOutOfStockQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
});
export type ListOutOfStockQuery = z.infer<typeof ListOutOfStockQuerySchema>;

export const OutOfStockMarkingSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  productId: z.string().uuid().nullable(),
  variantId: z.string().uuid().nullable(),
  reason: z.string().nullable(),
  markedByUserId: z.string().uuid(),
  markedAt: z.string(),
});
export type OutOfStockMarking = z.infer<typeof OutOfStockMarkingSchema>;
