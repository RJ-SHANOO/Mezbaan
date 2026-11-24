import { z } from "zod";

export const InventoryStatusSchema = z.enum(["active", "inactive"]);
export type InventoryStatus = z.infer<typeof InventoryStatusSchema>;

export const CreateInventoryCategorySchema = z.object({
  name: z.string().min(1),
  sortOrder: z.number().int().optional(),
});
export type CreateInventoryCategory = z.infer<typeof CreateInventoryCategorySchema>;

export const UpdateInventoryCategorySchema = z.object({
  name: z.string().min(1).optional(),
  sortOrder: z.number().int().optional(),
  status: InventoryStatusSchema.optional(),
});
export type UpdateInventoryCategory = z.infer<typeof UpdateInventoryCategorySchema>;

export const InventoryCategorySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  sortOrder: z.number().int(),
  status: InventoryStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type InventoryCategory = z.infer<typeof InventoryCategorySchema>;

export const ListStorageLocationsQuerySchema = z.object({ branchId: z.string().uuid().optional() });
export type ListStorageLocationsQuery = z.infer<typeof ListStorageLocationsQuerySchema>;

export const CreateStorageLocationSchema = z.object({
  branchId: z.string().uuid(),
  name: z.string().min(1),
  sortOrder: z.number().int().optional(),
  isSaleDeductionDefault: z.boolean().optional(),
});
export type CreateStorageLocation = z.infer<typeof CreateStorageLocationSchema>;

export const UpdateStorageLocationSchema = z.object({
  name: z.string().min(1).optional(),
  sortOrder: z.number().int().optional(),
  isSaleDeductionDefault: z.boolean().optional(),
});
export type UpdateStorageLocation = z.infer<typeof UpdateStorageLocationSchema>;

export const StorageLocationSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  name: z.string(),
  sortOrder: z.number().int(),
  isSaleDeductionDefault: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StorageLocation = z.infer<typeof StorageLocationSchema>;

export const ListInventoryItemsQuerySchema = z.object({ categoryId: z.string().uuid().optional() });
export type ListInventoryItemsQuery = z.infer<typeof ListInventoryItemsQuerySchema>;

/** P3-15: "semi_finished" means this item is made in-house from its own
 * recipe (a sauce, marinated meat, ...), not bought from a supplier —
 * see inventory-items.ts's own docs. */
export const InventoryItemTypeSchema = z.enum(["raw", "semi_finished"]);
export type InventoryItemType = z.infer<typeof InventoryItemTypeSchema>;

export const CreateInventoryItemSchema = z.object({
  categoryId: z.string().uuid(),
  name: z.string().min(1),
  sku: z.string().min(1).optional(),
  barcode: z.string().min(1).optional(),
  baseUnitId: z.string().uuid(),
  purchaseUnitId: z.string().uuid().optional(),
  itemType: InventoryItemTypeSchema.optional(),
});
export type CreateInventoryItem = z.infer<typeof CreateInventoryItemSchema>;

export const UpdateInventoryItemSchema = z.object({
  categoryId: z.string().uuid().optional(),
  name: z.string().min(1).optional(),
  sku: z.string().min(1).nullable().optional(),
  barcode: z.string().min(1).nullable().optional(),
  baseUnitId: z.string().uuid().optional(),
  purchaseUnitId: z.string().uuid().nullable().optional(),
  itemType: InventoryItemTypeSchema.optional(),
  status: InventoryStatusSchema.optional(),
});
export type UpdateInventoryItem = z.infer<typeof UpdateInventoryItemSchema>;

export const InventoryItemSchema = z.object({
  id: z.string().uuid(),
  categoryId: z.string().uuid(),
  name: z.string(),
  sku: z.string().nullable(),
  barcode: z.string().nullable(),
  baseUnitId: z.string().uuid(),
  purchaseUnitId: z.string().uuid().nullable(),
  itemType: InventoryItemTypeSchema,
  status: InventoryStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type InventoryItem = z.infer<typeof InventoryItemSchema>;
