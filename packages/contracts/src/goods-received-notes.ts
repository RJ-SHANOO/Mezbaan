import { z } from "zod";

const MINOR_UNITS_PATTERN = /^-?\d+$/;
const MinorUnitsSchema = z.string().regex(MINOR_UNITS_PATTERN, "must be an integer string");

export const SetGoodsRejectionReasonCodeSchema = z.object({
  code: z.string().min(1),
  label: z.string().min(1),
  isActive: z.boolean().optional(),
});
export type SetGoodsRejectionReasonCode = z.infer<typeof SetGoodsRejectionReasonCodeSchema>;

export const GoodsRejectionReasonCodeSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  label: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type GoodsRejectionReasonCode = z.infer<typeof GoodsRejectionReasonCodeSchema>;

export const GoodsReceivedNoteItemInputSchema = z
  .object({
    purchaseOrderItemId: z.string().uuid(),
    deliveredQuantity: z.number().positive(),
    rejectedQuantity: z.number().min(0).optional(),
    rejectionReasonCode: z.string().min(1).optional(),
    invoicedUnitCostMinor: MinorUnitsSchema,
  })
  .refine((data) => (data.rejectedQuantity ?? 0) <= data.deliveredQuantity, {
    message: "rejectedQuantity cannot exceed deliveredQuantity",
    path: ["rejectedQuantity"],
  })
  .refine((data) => (data.rejectedQuantity ?? 0) === 0 || data.rejectionReasonCode !== undefined, {
    message: "rejectionReasonCode is required whenever rejectedQuantity is greater than zero",
    path: ["rejectionReasonCode"],
  });
export type GoodsReceivedNoteItemInput = z.infer<typeof GoodsReceivedNoteItemInputSchema>;

export const RecordGoodsReceivedNoteSchema = z.object({
  purchaseOrderId: z.string().uuid(),
  storageLocationId: z.string().uuid(),
  note: z.string().min(1).optional(),
  items: z.array(GoodsReceivedNoteItemInputSchema).min(1),
});
export type RecordGoodsReceivedNote = z.infer<typeof RecordGoodsReceivedNoteSchema>;

export const GoodsReceivedNoteItemSchema = z.object({
  id: z.string().uuid(),
  purchaseOrderItemId: z.string().uuid(),
  itemId: z.string().uuid(),
  deliveredQuantity: z.number(),
  rejectedQuantity: z.number(),
  acceptedQuantity: z.number(),
  rejectionReasonCode: z.string().nullable(),
  invoicedUnitCostMinor: MinorUnitsSchema,
  orderedUnitCostMinor: MinorUnitsSchema,
  priceDifferenceMinor: MinorUnitsSchema,
  currency: z.string(),
  createdAt: z.string(),
});
export type GoodsReceivedNoteItem = z.infer<typeof GoodsReceivedNoteItemSchema>;

export const GoodsReceivedNoteSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  purchaseOrderId: z.string().uuid(),
  storageLocationId: z.string().uuid(),
  receivedByUserId: z.string().uuid(),
  note: z.string().nullable(),
  items: z.array(GoodsReceivedNoteItemSchema),
  createdAt: z.string(),
});
export type GoodsReceivedNote = z.infer<typeof GoodsReceivedNoteSchema>;
