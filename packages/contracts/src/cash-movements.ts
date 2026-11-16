import { z } from "zod";

const MINOR_UNITS_PATTERN = /^-?\d+$/;
const MinorUnitsSchema = z.string().regex(MINOR_UNITS_PATTERN, "must be an integer string");

export const SetCashMovementReasonCodeSchema = z.object({
  code: z.string().min(1),
  label: z.string().min(1),
  isActive: z.boolean().optional(),
});
export type SetCashMovementReasonCode = z.infer<typeof SetCashMovementReasonCodeSchema>;

export const CashMovementReasonCodeSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  label: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CashMovementReasonCode = z.infer<typeof CashMovementReasonCodeSchema>;

export const RecordCashMovementSchema = z.object({
  amountMinor: MinorUnitsSchema,
  reasonCode: z.string().min(1),
  note: z.string().min(1).optional(),
});
export type RecordCashMovement = z.infer<typeof RecordCashMovementSchema>;

export const CashMovementDirectionSchema = z.enum(["in", "out"]);
export type CashMovementDirection = z.infer<typeof CashMovementDirectionSchema>;

export const CashMovementSchema = z.object({
  id: z.string().uuid(),
  shiftId: z.string().uuid(),
  direction: CashMovementDirectionSchema,
  amountMinor: MinorUnitsSchema,
  currency: z.string(),
  reasonCode: z.string(),
  note: z.string().nullable(),
  actorUserId: z.string().uuid(),
  createdAt: z.string(),
});
export type CashMovement = z.infer<typeof CashMovementSchema>;

export const CashDrawerOpenTriggerSchema = z.enum(["no_sale", "cash_in", "cash_out", "shift_open", "shift_close", "manual"]);
export type CashDrawerOpenTrigger = z.infer<typeof CashDrawerOpenTriggerSchema>;

export const LogDrawerOpenSchema = z.object({
  trigger: CashDrawerOpenTriggerSchema.optional(),
});
export type LogDrawerOpen = z.infer<typeof LogDrawerOpenSchema>;

export const CashDrawerOpenEventSchema = z.object({
  id: z.string().uuid(),
  shiftId: z.string().uuid(),
  trigger: CashDrawerOpenTriggerSchema,
  actorUserId: z.string().uuid(),
  createdAt: z.string(),
});
export type CashDrawerOpenEvent = z.infer<typeof CashDrawerOpenEventSchema>;
