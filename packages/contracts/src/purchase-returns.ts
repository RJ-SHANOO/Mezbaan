import { z } from "zod";

export const SetPurchaseReturnReasonCodeSchema = z.object({
  code: z.string().min(1),
  label: z.string().min(1),
  isActive: z.boolean().optional(),
});
export type SetPurchaseReturnReasonCode = z.infer<typeof SetPurchaseReturnReasonCodeSchema>;

export const PurchaseReturnReasonCodeSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  label: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PurchaseReturnReasonCode = z.infer<typeof PurchaseReturnReasonCodeSchema>;

export const PurchaseReturnItemInputSchema = z.object({
  purchaseOrderItemId: z.string().uuid(),
  quantity: z.number().positive(),
  reasonCode: z.string().min(1),
});
export type PurchaseReturnItemInput = z.infer<typeof PurchaseReturnItemInputSchema>;

export const RecordPurchaseReturnSchema = z.object({
  purchaseOrderId: z.string().uuid(),
  storageLocationId: z.string().uuid(),
  note: z.string().min(1).optional(),
  items: z.array(PurchaseReturnItemInputSchema).min(1),
});
export type RecordPurchaseReturn = z.infer<typeof RecordPurchaseReturnSchema>;

export const PurchaseReturnItemSchema = z.object({
  id: z.string().uuid(),
  purchaseOrderItemId: z.string().uuid(),
  itemId: z.string().uuid(),
  quantity: z.number(),
  reasonCode: z.string(),
  createdAt: z.string(),
});
export type PurchaseReturnItem = z.infer<typeof PurchaseReturnItemSchema>;

export const PurchaseReturnSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  purchaseOrderId: z.string().uuid(),
  storageLocationId: z.string().uuid(),
  returnedByUserId: z.string().uuid(),
  note: z.string().nullable(),
  items: z.array(PurchaseReturnItemSchema),
  createdAt: z.string(),
});
export type PurchaseReturn = z.infer<typeof PurchaseReturnSchema>;
