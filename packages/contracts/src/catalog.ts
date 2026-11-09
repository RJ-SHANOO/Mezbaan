import { z } from "zod";

export const CreateCategorySchema = z.object({
  name: z.string().min(1),
  sortOrder: z.number().int().optional(),
  imageUrl: z.string().url().optional(),
});
export type CreateCategory = z.infer<typeof CreateCategorySchema>;

export const UpdateCategorySchema = z.object({
  name: z.string().min(1).optional(),
  sortOrder: z.number().int().optional(),
  status: z.enum(["active", "inactive"]).optional(),
  imageUrl: z.string().url().nullable().optional(),
});
export type UpdateCategory = z.infer<typeof UpdateCategorySchema>;

export const CategorySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  sortOrder: z.number().int(),
  status: z.enum(["active", "inactive"]),
  imageUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Category = z.infer<typeof CategorySchema>;

export const CreateProductSchema = z.object({
  categoryId: z.string().uuid(),
  name: z.string().min(1),
  sku: z.string().min(1).optional(),
  barcode: z.string().min(1).optional(),
  sortOrder: z.number().int().optional(),
  imageUrl: z.string().url().optional(),
});
export type CreateProduct = z.infer<typeof CreateProductSchema>;

export const UpdateProductSchema = z.object({
  categoryId: z.string().uuid().optional(),
  name: z.string().min(1).optional(),
  sku: z.string().min(1).nullable().optional(),
  barcode: z.string().min(1).nullable().optional(),
  sortOrder: z.number().int().optional(),
  status: z.enum(["active", "inactive"]).optional(),
  imageUrl: z.string().url().nullable().optional(),
});
export type UpdateProduct = z.infer<typeof UpdateProductSchema>;

export const ProductSchema = z.object({
  id: z.string().uuid(),
  categoryId: z.string().uuid(),
  name: z.string(),
  sku: z.string().nullable(),
  barcode: z.string().nullable(),
  sortOrder: z.number().int(),
  status: z.enum(["active", "inactive"]),
  imageUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Product = z.infer<typeof ProductSchema>;

export const SetProductBranchAvailabilitySchema = z.object({
  branchId: z.string().uuid(),
  available: z.boolean(),
});
export type SetProductBranchAvailability = z.infer<typeof SetProductBranchAvailabilitySchema>;

export const ProductBranchAvailabilitySchema = z.object({
  branchId: z.string().uuid(),
  available: z.boolean(),
});
export type ProductBranchAvailability = z.infer<typeof ProductBranchAvailabilitySchema>;

export const CreateProductVariantSchema = z.object({
  name: z.string().min(1),
  sku: z.string().min(1).optional(),
  barcode: z.string().min(1).optional(),
  sortOrder: z.number().int().optional(),
});
export type CreateProductVariant = z.infer<typeof CreateProductVariantSchema>;

export const UpdateProductVariantSchema = z.object({
  name: z.string().min(1).optional(),
  sku: z.string().min(1).nullable().optional(),
  barcode: z.string().min(1).nullable().optional(),
  sortOrder: z.number().int().optional(),
  status: z.enum(["active", "inactive"]).optional(),
});
export type UpdateProductVariant = z.infer<typeof UpdateProductVariantSchema>;

export const ProductVariantSchema = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  name: z.string(),
  sku: z.string().nullable(),
  barcode: z.string().nullable(),
  sortOrder: z.number().int(),
  status: z.enum(["active", "inactive"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProductVariant = z.infer<typeof ProductVariantSchema>;
