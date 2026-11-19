import { z } from "zod";
import { pageResponseSchema } from "./pagination.js";

const MINOR_UNITS_PATTERN = /^-?\d+$/;
const MinorUnitsSchema = z.string().regex(MINOR_UNITS_PATTERN, "must be an integer string");

export const OpenShiftSchema = z.object({
  deviceId: z.string().uuid(),
  openingFloatMinor: MinorUnitsSchema,
  currency: z.string().min(1),
  openingNote: z.string().min(1).optional(),
});
export type OpenShift = z.infer<typeof OpenShiftSchema>;

export const DenominationCountSchema = z.object({
  denominationMinor: MinorUnitsSchema,
  count: z.number().int().min(0),
});
export type DenominationCount = z.infer<typeof DenominationCountSchema>;

export const CloseShiftSchema = z.object({
  denominationCounts: z.array(DenominationCountSchema).min(1),
  closingNote: z.string().min(1).optional(),
});
export type CloseShift = z.infer<typeof CloseShiftSchema>;

export const ShiftStatusSchema = z.enum(["open", "closed"]);
export type ShiftStatus = z.infer<typeof ShiftStatusSchema>;

export const ShiftSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  deviceId: z.string().uuid(),
  openedByUserId: z.string().uuid(),
  openingFloatMinor: MinorUnitsSchema,
  openingNote: z.string().nullable(),
  currency: z.string(),
  status: ShiftStatusSchema,
  openedAt: z.string(),
  closedByUserId: z.string().uuid().nullable(),
  closedAt: z.string().nullable(),
  closingCashCounts: z.array(DenominationCountSchema).nullable(),
  countedCashMinor: MinorUnitsSchema.nullable(),
  closingNote: z.string().nullable(),
});
export type Shift = z.infer<typeof ShiftSchema>;

export const ListShiftsQuerySchema = z.object({
  branchId: z.string().uuid(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListShiftsQuery = z.infer<typeof ListShiftsQuerySchema>;

export const ShiftPageSchema = pageResponseSchema(ShiftSchema);
export type ShiftPage = z.infer<typeof ShiftPageSchema>;
