import { z } from "zod";

export const CreateComboSchema = z.object({
  name: z.string().min(1),
  sortOrder: z.number().int().optional(),
  imageUrl: z.string().url().optional(),
});
export type CreateCombo = z.infer<typeof CreateComboSchema>;

export const UpdateComboSchema = z.object({
  name: z.string().min(1).optional(),
  sortOrder: z.number().int().optional(),
  status: z.enum(["active", "inactive"]).optional(),
  imageUrl: z.string().url().nullable().optional(),
});
export type UpdateCombo = z.infer<typeof UpdateComboSchema>;

export const ComboSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  sortOrder: z.number().int(),
  status: z.enum(["active", "inactive"]),
  imageUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Combo = z.infer<typeof ComboSchema>;

const slotSelectionRule = { minSelections: z.number().int().min(0).optional(), maxSelections: z.number().int().min(1).optional() };

export const CreateComboSlotSchema = z
  .object({ name: z.string().min(1), kind: z.enum(["fixed", "choice"]), sortOrder: z.number().int().optional(), ...slotSelectionRule })
  .refine((data) => data.maxSelections === undefined || data.minSelections === undefined || data.maxSelections >= data.minSelections, {
    message: "maxSelections must be greater than or equal to minSelections",
    path: ["maxSelections"],
  });
export type CreateComboSlot = z.infer<typeof CreateComboSlotSchema>;

export const UpdateComboSlotSchema = z
  .object({ name: z.string().min(1).optional(), sortOrder: z.number().int().optional(), ...slotSelectionRule })
  .refine((data) => data.maxSelections === undefined || data.minSelections === undefined || data.maxSelections >= data.minSelections, {
    message: "maxSelections must be greater than or equal to minSelections",
    path: ["maxSelections"],
  });
export type UpdateComboSlot = z.infer<typeof UpdateComboSlotSchema>;

export const ComboSlotSchema = z.object({
  id: z.string().uuid(),
  comboId: z.string().uuid(),
  name: z.string(),
  kind: z.enum(["fixed", "choice"]),
  minSelections: z.number().int(),
  maxSelections: z.number().int().nullable(),
  sortOrder: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ComboSlot = z.infer<typeof ComboSlotSchema>;

export const AttachComboSlotItemSchema = z.object({
  productId: z.string().uuid(),
  sortOrder: z.number().int().optional(),
});
export type AttachComboSlotItem = z.infer<typeof AttachComboSlotItemSchema>;

export const ComboSlotItemSchema = z.object({
  id: z.string().uuid(),
  comboSlotId: z.string().uuid(),
  productId: z.string().uuid(),
  sortOrder: z.number().int(),
});
export type ComboSlotItem = z.infer<typeof ComboSlotItemSchema>;
