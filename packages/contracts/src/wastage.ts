import { z } from "zod";
import { pageResponseSchema } from "./pagination.js";

const MINOR_UNITS_PATTERN = /^-?\d+$/;
const MinorUnitsSchema = z.string().regex(MINOR_UNITS_PATTERN, "must be an integer string");

export const SetWastageReasonCodeSchema = z.object({
  code: z.string().min(1),
  label: z.string().min(1),
  isActive: z.boolean().optional(),
});
export type SetWastageReasonCode = z.infer<typeof SetWastageReasonCodeSchema>;

export const WastageReasonCodeSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  label: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WastageReasonCode = z.infer<typeof WastageReasonCodeSchema>;

export const UpdateWastageLimitSettingsSchema = z.object({
  maxUnapprovedCostMinor: MinorUnitsSchema.nullable(),
});
export type UpdateWastageLimitSettings = z.infer<typeof UpdateWastageLimitSettingsSchema>;

export const WastageLimitSettingsSchema = z.object({
  maxUnapprovedCostMinor: MinorUnitsSchema.nullable(),
  updatedByUserId: z.string().uuid(),
  updatedAt: z.string(),
});
export type WastageLimitSettings = z.infer<typeof WastageLimitSettingsSchema>;

export const RecordWastageSchema = z.object({
  branchId: z.string().uuid(),
  storageLocationId: z.string().uuid(),
  itemId: z.string().uuid(),
  quantity: z.number().positive(),
  reasonCode: z.string().min(1),
  note: z.string().min(1).optional(),
  managerUserId: z.string().uuid().optional(),
  managerPin: z.string().min(1).optional(),
});
export type RecordWastage = z.infer<typeof RecordWastageSchema>;

export const WastageEntrySchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  storageLocationId: z.string().uuid(),
  itemId: z.string().uuid(),
  quantity: z.number(),
  reasonCode: z.string(),
  costMinor: MinorUnitsSchema.nullable(),
  currency: z.string().nullable(),
  requiredApproval: z.boolean(),
  approvedByUserId: z.string().uuid().nullable(),
  actorUserId: z.string().uuid(),
  note: z.string().nullable(),
  createdAt: z.string(),
});
export type WastageEntry = z.infer<typeof WastageEntrySchema>;

export const ListWastageEntriesQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListWastageEntriesQuery = z.infer<typeof ListWastageEntriesQuerySchema>;

export const WastageEntryPageSchema = pageResponseSchema(WastageEntrySchema);
export type WastageEntryPage = z.infer<typeof WastageEntryPageSchema>;
