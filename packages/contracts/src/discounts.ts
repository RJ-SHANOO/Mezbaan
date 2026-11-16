import { z } from "zod";

const MINOR_UNITS_PATTERN = /^-?\d+$/;
const MinorUnitsSchema = z.string().regex(MINOR_UNITS_PATTERN, "must be an integer string");

export const SetDiscountReasonCodeSchema = z.object({
  code: z.string().min(1),
  label: z.string().min(1),
  isActive: z.boolean().optional(),
});
export type SetDiscountReasonCode = z.infer<typeof SetDiscountReasonCodeSchema>;

export const DiscountReasonCodeSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  label: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DiscountReasonCode = z.infer<typeof DiscountReasonCodeSchema>;

export const SetDiscountLimitsSchema = z.object({
  maxUnapprovedPercentBasisPoints: z.number().int().min(0).max(10_000).nullable().optional(),
  maxUnapprovedAmountMinor: MinorUnitsSchema.nullable().optional(),
});
export type SetDiscountLimits = z.infer<typeof SetDiscountLimitsSchema>;

export const DiscountLimitsSchema = z.object({
  maxUnapprovedPercentBasisPoints: z.number().int().nullable(),
  maxUnapprovedAmountMinor: MinorUnitsSchema.nullable(),
});
export type DiscountLimits = z.infer<typeof DiscountLimitsSchema>;

/** P2-22: exactly one of percentBasisPoints/amountMinor. managerUserId/managerPin
 * are only required when the discount exceeds the restaurant's own-authority
 * limit — the server, not the caller, decides whether that's the case. */
export const ApplyDiscountSchema = z
  .object({
    percentBasisPoints: z.number().int().min(1).max(10_000).optional(),
    amountMinor: MinorUnitsSchema.optional(),
    reasonCode: z.string().min(1),
    managerUserId: z.string().uuid().optional(),
    managerPin: z.string().min(1).optional(),
  })
  .refine((data) => (data.percentBasisPoints !== undefined) !== (data.amountMinor !== undefined), {
    message: "exactly one of percentBasisPoints or amountMinor must be given",
    path: ["percentBasisPoints"],
  });
export type ApplyDiscount = z.infer<typeof ApplyDiscountSchema>;

export const DiscountOutcomeSchema = z.object({
  discountMinor: MinorUnitsSchema,
  approvedByUserId: z.string().uuid().nullable(),
});
export type DiscountOutcome = z.infer<typeof DiscountOutcomeSchema>;
