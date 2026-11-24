import { z } from "zod";

export const SetVoidReasonCodeSchema = z.object({
  code: z.string().min(1),
  label: z.string().min(1),
  isActive: z.boolean().optional(),
});
export type SetVoidReasonCode = z.infer<typeof SetVoidReasonCodeSchema>;

export const VoidReasonCodeSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  label: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type VoidReasonCode = z.infer<typeof VoidReasonCodeSchema>;

export const VoidStockDispositionSchema = z.enum(["return_to_stock", "wastage"]);
export type VoidStockDisposition = z.infer<typeof VoidStockDispositionSchema>;

/** P2-23: managerUserId/managerPin are only required when the item has
 * already been fired to the kitchen — the server, not the caller, decides
 * whether that's the case. P3-18: stockDisposition is required under the
 * same condition — see VoidsService's own docs for why a pre-fire void
 * never needs one. */
export const VoidOrderItemSchema = z.object({
  reasonCode: z.string().min(1),
  managerUserId: z.string().uuid().optional(),
  managerPin: z.string().min(1).optional(),
  stockDisposition: VoidStockDispositionSchema.optional(),
});
export type VoidOrderItem = z.infer<typeof VoidOrderItemSchema>;

export const VoidOutcomeSchema = z.object({
  requiredApproval: z.boolean(),
  approvedByUserId: z.string().uuid().nullable(),
});
export type VoidOutcome = z.infer<typeof VoidOutcomeSchema>;
