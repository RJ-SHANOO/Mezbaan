import { z } from "zod";
import { CurrencyCodeSchema } from "./currency.js";

const MINOR_UNITS_PATTERN = /^-?\d+$/;
const MinorUnitsSchema = z.string().regex(MINOR_UNITS_PATTERN, "must be an integer string");

export const BillingPlanTypeSchema = z.enum(["commission_only", "hybrid"]);
export type BillingPlanType = z.infer<typeof BillingPlanTypeSchema>;

export const BillingCycleSchema = z.enum(["weekly", "biweekly", "monthly", "quarterly"]);
export type BillingCycle = z.infer<typeof BillingCycleSchema>;

/** P3-36: unlike restaurants.commissionRateBasisPoints (rule 7 — locked
 * forever at registration), the fixed fee and billing cycle are deliberately
 * configurable: a Super Admin can move a restaurant onto (or off) the hybrid
 * plan, or change its cycle, at any time. `fixedFeeMinor`/`fixedFeeCurrency`
 * are required together and only when `planType` is "hybrid" — a pure
 * commission plan has no fixed fee at all. */
export const SetBillingPlanSchema = z
  .object({
    planType: BillingPlanTypeSchema,
    fixedFeeMinor: MinorUnitsSchema.optional(),
    fixedFeeCurrency: CurrencyCodeSchema.optional(),
    billingCycle: BillingCycleSchema,
  })
  .refine((data) => (data.fixedFeeMinor === undefined) === (data.fixedFeeCurrency === undefined), {
    message: "fixedFeeMinor and fixedFeeCurrency must be given together, or not at all",
    path: ["fixedFeeMinor"],
  })
  .refine((data) => data.planType === "hybrid" || data.fixedFeeMinor === undefined, {
    message: "fixedFeeMinor is only valid when planType is \"hybrid\"",
    path: ["fixedFeeMinor"],
  })
  .refine((data) => data.planType !== "hybrid" || data.fixedFeeMinor !== undefined, {
    message: "fixedFeeMinor is required when planType is \"hybrid\"",
    path: ["fixedFeeMinor"],
  });
export type SetBillingPlan = z.infer<typeof SetBillingPlanSchema>;

/** The effective plan, whether or not a row has ever been written — a
 * restaurant that's never had one set reads back the default
 * (commission_only, monthly, no fixed fee), same "absence means the
 * default" convention as DiscountLimitsSchema. */
export const BillingPlanSchema = z.object({
  planType: BillingPlanTypeSchema,
  fixedFeeMinor: MinorUnitsSchema.nullable(),
  fixedFeeCurrency: CurrencyCodeSchema.nullable(),
  billingCycle: BillingCycleSchema,
});
export type BillingPlan = z.infer<typeof BillingPlanSchema>;
