import { z } from "zod";

export const PaymentMethodSchema = z.enum(["cash", "card", "bank_transfer", "wallet"]);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

export const SetPaymentMethodSettingSchema = z.object({
  method: PaymentMethodSchema,
  enabled: z.boolean(),
});
export type SetPaymentMethodSetting = z.infer<typeof SetPaymentMethodSettingSchema>;

export const PaymentMethodSettingSchema = z.object({
  id: z.string().uuid(),
  method: PaymentMethodSchema,
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PaymentMethodSetting = z.infer<typeof PaymentMethodSettingSchema>;
