import { z } from "zod";

export const RecipeItemInputSchema = z.object({
  itemId: z.string().uuid(),
  quantity: z.number().positive(),
  unitId: z.string().uuid(),
  yieldPercent: z.number().positive().max(100).optional(),
});
export type RecipeItemInput = z.infer<typeof RecipeItemInputSchema>;

/** Exactly one of productId/variantId/modifierOptionId/semiFinishedItemId
 * — modifierOptionId (P3-14) is a recipe rule for a modifier itself (e.g.
 * "Extra Cheese" adding mozzarella), and semiFinishedItemId (P3-15) is a
 * recipe rule for an in-house-made inventory item (e.g. "Marinara Sauce"),
 * both the same shape as a product/variant's own recipe. */
function exactlyOneOwner(data: { productId?: string; variantId?: string; modifierOptionId?: string; semiFinishedItemId?: string }): boolean {
  return [data.productId, data.variantId, data.modifierOptionId, data.semiFinishedItemId].filter((v) => v !== undefined).length === 1;
}

export const CreateOrReplaceRecipeSchema = z
  .object({
    productId: z.string().uuid().optional(),
    variantId: z.string().uuid().optional(),
    modifierOptionId: z.string().uuid().optional(),
    semiFinishedItemId: z.string().uuid().optional(),
    items: z.array(RecipeItemInputSchema).min(1),
  })
  .refine(exactlyOneOwner, {
    message: "exactly one of productId, variantId, modifierOptionId or semiFinishedItemId must be set",
    path: ["productId"],
  });
export type CreateOrReplaceRecipe = z.infer<typeof CreateOrReplaceRecipeSchema>;

export const RecipeItemSchema = z.object({
  id: z.string().uuid(),
  itemId: z.string().uuid(),
  quantity: z.number(),
  unitId: z.string().uuid(),
  yieldPercent: z.number(),
});
export type RecipeItem = z.infer<typeof RecipeItemSchema>;

export const RecipeSchema = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid().nullable(),
  variantId: z.string().uuid().nullable(),
  modifierOptionId: z.string().uuid().nullable(),
  semiFinishedItemId: z.string().uuid().nullable(),
  version: z.number().int(),
  items: z.array(RecipeItemSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Recipe = z.infer<typeof RecipeSchema>;

export const GetRecipeQuerySchema = z
  .object({
    productId: z.string().uuid().optional(),
    variantId: z.string().uuid().optional(),
    modifierOptionId: z.string().uuid().optional(),
    semiFinishedItemId: z.string().uuid().optional(),
  })
  .refine(exactlyOneOwner, {
    message: "exactly one of productId, variantId, modifierOptionId or semiFinishedItemId must be given",
    path: ["productId"],
  });
export type GetRecipeQuery = z.infer<typeof GetRecipeQuerySchema>;
