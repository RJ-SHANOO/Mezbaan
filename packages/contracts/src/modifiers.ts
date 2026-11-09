import { z } from "zod";

const selectionRule = { minSelections: z.number().int().min(0).optional(), maxSelections: z.number().int().min(1).optional() };

export const CreateModifierGroupSchema = z
  .object({ name: z.string().min(1), sortOrder: z.number().int().optional(), ...selectionRule })
  .refine((data) => data.maxSelections === undefined || data.minSelections === undefined || data.maxSelections >= data.minSelections, {
    message: "maxSelections must be greater than or equal to minSelections",
    path: ["maxSelections"],
  });
export type CreateModifierGroup = z.infer<typeof CreateModifierGroupSchema>;

export const UpdateModifierGroupSchema = z
  .object({
    name: z.string().min(1).optional(),
    sortOrder: z.number().int().optional(),
    status: z.enum(["active", "inactive"]).optional(),
    ...selectionRule,
  })
  .refine((data) => data.maxSelections === undefined || data.minSelections === undefined || data.maxSelections >= data.minSelections, {
    message: "maxSelections must be greater than or equal to minSelections",
    path: ["maxSelections"],
  });
export type UpdateModifierGroup = z.infer<typeof UpdateModifierGroupSchema>;

export const ModifierGroupSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  minSelections: z.number().int(),
  maxSelections: z.number().int().nullable(),
  sortOrder: z.number().int(),
  status: z.enum(["active", "inactive"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ModifierGroup = z.infer<typeof ModifierGroupSchema>;

export const CreateModifierOptionSchema = z.object({
  name: z.string().min(1),
  sortOrder: z.number().int().optional(),
});
export type CreateModifierOption = z.infer<typeof CreateModifierOptionSchema>;

export const UpdateModifierOptionSchema = z.object({
  name: z.string().min(1).optional(),
  sortOrder: z.number().int().optional(),
  status: z.enum(["active", "inactive"]).optional(),
});
export type UpdateModifierOption = z.infer<typeof UpdateModifierOptionSchema>;

export const ModifierOptionSchema = z.object({
  id: z.string().uuid(),
  modifierGroupId: z.string().uuid(),
  name: z.string(),
  sortOrder: z.number().int(),
  status: z.enum(["active", "inactive"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ModifierOption = z.infer<typeof ModifierOptionSchema>;

export const AttachModifierGroupSchema = z.object({
  modifierGroupId: z.string().uuid(),
  sortOrder: z.number().int().optional(),
});
export type AttachModifierGroup = z.infer<typeof AttachModifierGroupSchema>;

export const ProductModifierGroupSchema = z.object({
  modifierGroupId: z.string().uuid(),
  sortOrder: z.number().int(),
});
export type ProductModifierGroup = z.infer<typeof ProductModifierGroupSchema>;
