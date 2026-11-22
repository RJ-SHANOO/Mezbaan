import { z } from "zod";

export const CreateUnitSchema = z.object({
  name: z.string().min(1),
  abbreviation: z.string().min(1),
});
export type CreateUnit = z.infer<typeof CreateUnitSchema>;

export const UpdateUnitSchema = z.object({
  name: z.string().min(1).optional(),
  abbreviation: z.string().min(1).optional(),
});
export type UpdateUnit = z.infer<typeof UpdateUnitSchema>;

export const UnitSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  abbreviation: z.string(),
  createdAt: z.string(),
});
export type Unit = z.infer<typeof UnitSchema>;

export const SetUnitConversionSchema = z.object({
  unitId: z.string().uuid(),
  factorToBaseUnit: z.number().positive(),
});
export type SetUnitConversion = z.infer<typeof SetUnitConversionSchema>;

export const UnitConversionSchema = z.object({
  id: z.string().uuid(),
  itemId: z.string().uuid(),
  unitId: z.string().uuid(),
  factorToBaseUnit: z.number().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type UnitConversion = z.infer<typeof UnitConversionSchema>;

export const ConvertQuantityQuerySchema = z.object({
  quantity: z.coerce.number(),
  fromUnitId: z.string().uuid(),
  toUnitId: z.string().uuid(),
});
export type ConvertQuantityQuery = z.infer<typeof ConvertQuantityQuerySchema>;

export const ConvertedQuantitySchema = z.object({ quantity: z.number() });
export type ConvertedQuantity = z.infer<typeof ConvertedQuantitySchema>;
