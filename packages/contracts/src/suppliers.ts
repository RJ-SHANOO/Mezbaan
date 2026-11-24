import { z } from "zod";
import { CurrencyCodeSchema } from "./currency.js";
import { pageResponseSchema } from "./pagination.js";

const MINOR_UNITS_PATTERN = /^-?\d+$/;
const MinorUnitsSchema = z.string().regex(MINOR_UNITS_PATTERN, "must be an integer string");

export const SupplierStatusSchema = z.enum(["active", "inactive"]);
export type SupplierStatus = z.infer<typeof SupplierStatusSchema>;

export const CreateSupplierSchema = z.object({
  name: z.string().min(1),
  contactName: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  email: z.string().email().optional(),
  address: z.string().min(1).optional(),
});
export type CreateSupplier = z.infer<typeof CreateSupplierSchema>;

export const UpdateSupplierSchema = z.object({
  name: z.string().min(1).optional(),
  contactName: z.string().min(1).nullable().optional(),
  phone: z.string().min(1).nullable().optional(),
  email: z.string().email().nullable().optional(),
  address: z.string().min(1).nullable().optional(),
  status: SupplierStatusSchema.optional(),
});
export type UpdateSupplier = z.infer<typeof UpdateSupplierSchema>;

export const SupplierSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  contactName: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  status: SupplierStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Supplier = z.infer<typeof SupplierSchema>;

export const LinkSupplierItemSchema = z.object({
  supplierId: z.string().uuid(),
  itemId: z.string().uuid(),
  supplierSku: z.string().min(1).optional(),
});
export type LinkSupplierItem = z.infer<typeof LinkSupplierItemSchema>;

export const UpdateSupplierItemSchema = z.object({
  supplierSku: z.string().min(1).nullable(),
});
export type UpdateSupplierItem = z.infer<typeof UpdateSupplierItemSchema>;

export const ListSupplierItemsQuerySchema = z.object({
  supplierId: z.string().uuid().optional(),
  itemId: z.string().uuid().optional(),
});
export type ListSupplierItemsQuery = z.infer<typeof ListSupplierItemsQuerySchema>;

export const SupplierItemSchema = z.object({
  id: z.string().uuid(),
  supplierId: z.string().uuid(),
  itemId: z.string().uuid(),
  supplierSku: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SupplierItem = z.infer<typeof SupplierItemSchema>;

export const RecordSupplierItemPriceSchema = z.object({
  supplierId: z.string().uuid(),
  itemId: z.string().uuid(),
  unitPriceMinor: MinorUnitsSchema,
  currency: CurrencyCodeSchema,
  unitId: z.string().uuid(),
  note: z.string().min(1).optional(),
});
export type RecordSupplierItemPrice = z.infer<typeof RecordSupplierItemPriceSchema>;

export const SupplierItemPriceSchema = z.object({
  id: z.string().uuid(),
  supplierId: z.string().uuid(),
  itemId: z.string().uuid(),
  unitPriceMinor: MinorUnitsSchema,
  currency: z.string(),
  unitId: z.string().uuid(),
  note: z.string().nullable(),
  actorUserId: z.string().uuid(),
  createdAt: z.string(),
});
export type SupplierItemPrice = z.infer<typeof SupplierItemPriceSchema>;

export const ListSupplierItemPricesQuerySchema = z.object({
  supplierId: z.string().uuid(),
  itemId: z.string().uuid(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListSupplierItemPricesQuery = z.infer<typeof ListSupplierItemPricesQuerySchema>;

export const SupplierItemPricePageSchema = pageResponseSchema(SupplierItemPriceSchema);
export type SupplierItemPricePage = z.infer<typeof SupplierItemPricePageSchema>;
