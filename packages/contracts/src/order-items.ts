import { z } from "zod";

const MINOR_UNITS_PATTERN = /^-?\d+$/;
const UnitPriceMinorSchema = z.string().regex(MINOR_UNITS_PATTERN, "unitPriceMinor must be an integer string");

export const AddOrderItemSchema = z
  .object({
    productId: z.string().uuid().optional(),
    variantId: z.string().uuid().optional(),
    quantity: z.number().int().positive().optional(),
    notes: z.string().min(1).optional(),
    seatNumber: z.number().int().positive().optional(),
    course: z.string().min(1).optional(),
    modifierOptionIds: z.array(z.string().uuid()).optional(),
  })
  .refine((data) => (data.productId !== undefined) !== (data.variantId !== undefined), {
    message: "exactly one of productId or variantId must be set",
    path: ["productId"],
  });
export type AddOrderItem = z.infer<typeof AddOrderItemSchema>;

export const UpdateOrderItemSchema = z.object({
  quantity: z.number().int().positive().optional(),
  notes: z.string().min(1).nullable().optional(),
  seatNumber: z.number().int().positive().nullable().optional(),
  course: z.string().min(1).nullable().optional(),
});
export type UpdateOrderItem = z.infer<typeof UpdateOrderItemSchema>;

/** P2-15: fire either a named set of items, or every un-fired item of a course, to the kitchen. */
export const FireOrderItemsSchema = z
  .object({
    itemIds: z.array(z.string().uuid()).min(1).optional(),
    course: z.string().min(1).optional(),
    rush: z.boolean().optional(),
  })
  .refine((data) => (data.itemIds !== undefined) !== (data.course !== undefined), {
    message: "exactly one of itemIds or course must be given",
    path: ["itemIds"],
  });
export type FireOrderItems = z.infer<typeof FireOrderItemsSchema>;

export const OrderItemModifierSchema = z.object({
  id: z.string().uuid(),
  modifierOptionId: z.string().uuid(),
  quantity: z.number().int(),
  unitPriceMinor: UnitPriceMinorSchema,
  currency: z.string(),
});
export type OrderItemModifier = z.infer<typeof OrderItemModifierSchema>;

export const OrderItemSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  productId: z.string().uuid().nullable(),
  variantId: z.string().uuid().nullable(),
  quantity: z.number().int(),
  unitPriceMinor: UnitPriceMinorSchema,
  currency: z.string(),
  priceListId: z.string().uuid(),
  priceListVersion: z.number().int(),
  notes: z.string().nullable(),
  seatNumber: z.number().int().nullable(),
  course: z.string().nullable(),
  firedAt: z.string().nullable(),
  firedByUserId: z.string().uuid().nullable(),
  rush: z.boolean(),
  invoiceId: z.string().uuid().nullable(),
  discountPercentBasisPoints: z.number().int().nullable(),
  discountAmountMinor: UnitPriceMinorSchema.nullable(),
  discountReasonCode: z.string().nullable(),
  discountApprovedByUserId: z.string().uuid().nullable(),
  voidedAt: z.string().nullable(),
  voidedByUserId: z.string().uuid().nullable(),
  voidReasonCode: z.string().nullable(),
  voidApprovedByUserId: z.string().uuid().nullable(),
  modifiers: z.array(OrderItemModifierSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OrderItem = z.infer<typeof OrderItemSchema>;
