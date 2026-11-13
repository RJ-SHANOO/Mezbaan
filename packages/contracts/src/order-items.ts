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
  modifiers: z.array(OrderItemModifierSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OrderItem = z.infer<typeof OrderItemSchema>;
