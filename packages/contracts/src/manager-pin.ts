import { z } from "zod";

const PinSchema = z.string().regex(/^\d{4,6}$/, "PIN must be 4-6 digits");

export const SetManagerPinSchema = z.object({
  pin: PinSchema,
});
export type SetManagerPin = z.infer<typeof SetManagerPinSchema>;

// What's being approved — the server maps this to the permission key it actually
// requires (e.g. "void" -> "pos.void.approve"); the client never names a permission
// directly, so it can't talk its way into a check it doesn't actually satisfy.
export const ManagerPinApprovableActionSchema = z.enum(["void", "refund"]);
export type ManagerPinApprovableAction = z.infer<typeof ManagerPinApprovableActionSchema>;

export const ApproveManagerPinSchema = z.object({
  managerUserId: z.string().uuid(),
  pin: PinSchema,
  action: ManagerPinApprovableActionSchema,
});
export type ApproveManagerPin = z.infer<typeof ApproveManagerPinSchema>;
