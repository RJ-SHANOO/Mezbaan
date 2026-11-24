import { z } from "zod";
import { CurrencyCodeSchema } from "./currency.js";
import { pageResponseSchema } from "./pagination.js";

const MINOR_UNITS_PATTERN = /^-?\d+$/;
const MinorUnitsSchema = z.string().regex(MINOR_UNITS_PATTERN, "must be an integer string");

export const SupplierInvoiceItemInputSchema = z.object({
  purchaseOrderItemId: z.string().uuid(),
  quantity: z.number().positive(),
  unitCostMinor: MinorUnitsSchema,
});
export type SupplierInvoiceItemInput = z.infer<typeof SupplierInvoiceItemInputSchema>;

export const RecordSupplierInvoiceSchema = z.object({
  purchaseOrderId: z.string().uuid(),
  supplierInvoiceNumber: z.string().min(1),
  currency: CurrencyCodeSchema,
  totalMinor: MinorUnitsSchema,
  items: z.array(SupplierInvoiceItemInputSchema).min(1),
});
export type RecordSupplierInvoice = z.infer<typeof RecordSupplierInvoiceSchema>;

export const SupplierInvoiceItemSchema = z.object({
  id: z.string().uuid(),
  purchaseOrderItemId: z.string().uuid(),
  itemId: z.string().uuid(),
  quantity: z.number(),
  unitCostMinor: MinorUnitsSchema,
  currency: z.string(),
});
export type SupplierInvoiceItem = z.infer<typeof SupplierInvoiceItemSchema>;

export const SupplierInvoiceSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  purchaseOrderId: z.string().uuid(),
  supplierId: z.string().uuid(),
  supplierInvoiceNumber: z.string(),
  currency: z.string(),
  totalMinor: MinorUnitsSchema,
  recordedByUserId: z.string().uuid(),
  items: z.array(SupplierInvoiceItemSchema),
  createdAt: z.string(),
});
export type SupplierInvoice = z.infer<typeof SupplierInvoiceSchema>;

export const SupplierInvoiceMatchFlagSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  supplierInvoiceId: z.string().uuid(),
  supplierInvoiceItemId: z.string().uuid(),
  purchaseOrderItemId: z.string().uuid(),
  invoicedQuantity: z.number(),
  orderedQuantity: z.number(),
  receivedQuantity: z.number(),
  invoicedUnitCostMinor: MinorUnitsSchema,
  orderedUnitCostMinor: MinorUnitsSchema,
  currency: z.string(),
  mismatchedFields: z.string(),
  reviewedAt: z.string().nullable(),
  reviewedByUserId: z.string().uuid().nullable(),
  createdAt: z.string(),
});
export type SupplierInvoiceMatchFlag = z.infer<typeof SupplierInvoiceMatchFlagSchema>;

export const RecordSupplierInvoiceResultSchema = z.object({
  invoice: SupplierInvoiceSchema,
  flags: z.array(SupplierInvoiceMatchFlagSchema),
});
export type RecordSupplierInvoiceResult = z.infer<typeof RecordSupplierInvoiceResultSchema>;

export const ListSupplierInvoiceMatchFlagsQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  reviewed: z.coerce.boolean().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListSupplierInvoiceMatchFlagsQuery = z.infer<typeof ListSupplierInvoiceMatchFlagsQuerySchema>;

export const SupplierInvoiceMatchFlagPageSchema = pageResponseSchema(SupplierInvoiceMatchFlagSchema);
export type SupplierInvoiceMatchFlagPage = z.infer<typeof SupplierInvoiceMatchFlagPageSchema>;
