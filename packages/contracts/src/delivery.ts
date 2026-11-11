import { z } from "zod";

export const CreateDeliveryRiderSchema = z.object({
  branchId: z.string().uuid(),
  name: z.string().min(1),
  phone: z.string().min(1),
});
export type CreateDeliveryRider = z.infer<typeof CreateDeliveryRiderSchema>;

export const UpdateDeliveryRiderSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateDeliveryRider = z.infer<typeof UpdateDeliveryRiderSchema>;

export const DeliveryRiderSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  name: z.string(),
  phone: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DeliveryRider = z.infer<typeof DeliveryRiderSchema>;

export const SetDeliveryDetailsSchema = z.object({
  customerName: z.string().min(1),
  customerPhone: z.string().min(1),
  addressLine1: z.string().min(1),
  addressLine2: z.string().min(1).optional(),
  city: z.string().min(1).optional(),
  deliveryInstructions: z.string().min(1).optional(),
});
export type SetDeliveryDetails = z.infer<typeof SetDeliveryDetailsSchema>;

export const AssignRiderSchema = z.object({
  riderId: z.string().uuid(),
});
export type AssignRider = z.infer<typeof AssignRiderSchema>;

export const DeliveryStatusSchema = z.enum(["pending", "assigned", "out_for_delivery", "delivered", "failed"]);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

export const UpdateDeliveryStatusSchema = z.object({
  status: DeliveryStatusSchema,
});
export type UpdateDeliveryStatus = z.infer<typeof UpdateDeliveryStatusSchema>;

export const DeliveryDetailsSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  customerName: z.string(),
  customerPhone: z.string(),
  addressLine1: z.string(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  deliveryInstructions: z.string().nullable(),
  riderId: z.string().uuid().nullable(),
  deliveryStatus: DeliveryStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DeliveryDetails = z.infer<typeof DeliveryDetailsSchema>;
