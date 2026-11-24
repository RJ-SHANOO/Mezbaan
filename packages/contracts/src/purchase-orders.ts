import { z } from "zod";
import { CurrencyCodeSchema } from "./currency.js";
import { pageResponseSchema } from "./pagination.js";

const MINOR_UNITS_PATTERN = /^-?\d+$/;
const MinorUnitsSchema = z.string().regex(MINOR_UNITS_PATTERN, "must be an integer string");

export const PurchaseOrderStatusSchema = z.enum(["draft", "approved", "sent", "partly_received", "closed"]);
export type PurchaseOrderStatus = z.infer<typeof PurchaseOrderStatusSchema>;

export const PurchaseOrderItemInputSchema = z.object({
  itemId: z.string().uuid(),
  quantity: z.number().positive(),
  unitId: z.string().uuid(),
  unitCostMinor: MinorUnitsSchema,
});
export type PurchaseOrderItemInput = z.infer<typeof PurchaseOrderItemInputSchema>;

export const CreatePurchaseOrderSchema = z.object({
  branchId: z.string().uuid(),
  supplierId: z.string().uuid(),
  currency: CurrencyCodeSchema,
  note: z.string().min(1).optional(),
  items: z.array(PurchaseOrderItemInputSchema).min(1),
});
export type CreatePurchaseOrder = z.infer<typeof CreatePurchaseOrderSchema>;

export const ReplacePurchaseOrderItemsSchema = z.object({
  items: z.array(PurchaseOrderItemInputSchema).min(1),
});
export type ReplacePurchaseOrderItems = z.infer<typeof ReplacePurchaseOrderItemsSchema>;

export const ApprovePurchaseOrderSchema = z.object({
  managerUserId: z.string().uuid(),
  managerPin: z.string().min(1),
});
export type ApprovePurchaseOrder = z.infer<typeof ApprovePurchaseOrderSchema>;

export const PurchaseOrderItemSchema = z.object({
  id: z.string().uuid(),
  itemId: z.string().uuid(),
  quantity: z.number(),
  unitId: z.string().uuid(),
  unitCostMinor: MinorUnitsSchema,
  currency: z.string(),
  receivedQuantity: z.number(),
});
export type PurchaseOrderItem = z.infer<typeof PurchaseOrderItemSchema>;

export const PurchaseOrderSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  supplierId: z.string().uuid(),
  status: PurchaseOrderStatusSchema,
  currency: z.string(),
  note: z.string().nullable(),
  createdByUserId: z.string().uuid(),
  approvedByUserId: z.string().uuid().nullable(),
  approvedAt: z.string().nullable(),
  sentAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  items: z.array(PurchaseOrderItemSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PurchaseOrder = z.infer<typeof PurchaseOrderSchema>;

export const PurchaseOrderSummarySchema = PurchaseOrderSchema.omit({ items: true });
export type PurchaseOrderSummary = z.infer<typeof PurchaseOrderSummarySchema>;

export const ListPurchaseOrdersQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  status: PurchaseOrderStatusSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListPurchaseOrdersQuery = z.infer<typeof ListPurchaseOrdersQuerySchema>;

export const PurchaseOrderSummaryPageSchema = pageResponseSchema(PurchaseOrderSummarySchema);
export type PurchaseOrderSummaryPage = z.infer<typeof PurchaseOrderSummaryPageSchema>;
