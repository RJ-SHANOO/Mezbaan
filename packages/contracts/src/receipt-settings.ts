import { z } from "zod";

export const SetReceiptSettingsSchema = z.object({
  logoUrl: z.string().min(1).nullable().optional(),
  headerText: z.string().min(1).nullable().optional(),
  footerText: z.string().min(1).nullable().optional(),
  showTaxBreakdown: z.boolean().optional(),
  showServiceCharge: z.boolean().optional(),
});
export type SetReceiptSettings = z.infer<typeof SetReceiptSettingsSchema>;

export const ReceiptSettingsSchema = z.object({
  logoUrl: z.string().nullable(),
  headerText: z.string().nullable(),
  footerText: z.string().nullable(),
  showTaxBreakdown: z.boolean(),
  showServiceCharge: z.boolean(),
  updatedAt: z.string(),
});
export type ReceiptSettings = z.infer<typeof ReceiptSettingsSchema>;
