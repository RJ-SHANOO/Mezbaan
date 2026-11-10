import { z } from "zod";
import { OrderTypeSchema } from "./price-lists.js";

const RateBasisPointsSchema = z.number().int().min(0);

/** bigint-over-the-wire, same decimal-string convention as MoneyWireSchema and
 * price-lists.ts's unitPriceMinor — survives JSON without precision loss. */
const MinorUnitsSchema = z.string().regex(/^-?\d+$/, "must be an integer string");

export const CreateTaxRuleSchema = z.object({
  name: z.string().min(1),
  rateBasisPoints: RateBasisPointsSchema,
  branchId: z.string().uuid().optional(),
  orderType: OrderTypeSchema.optional(),
});
export type CreateTaxRule = z.infer<typeof CreateTaxRuleSchema>;

export const UpdateTaxRuleSchema = z.object({
  name: z.string().min(1).optional(),
  rateBasisPoints: RateBasisPointsSchema.optional(),
  branchId: z.string().uuid().nullable().optional(),
  orderType: OrderTypeSchema.nullable().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateTaxRule = z.infer<typeof UpdateTaxRuleSchema>;

export const TaxRuleSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  rateBasisPoints: z.number().int(),
  branchId: z.string().uuid().nullable(),
  orderType: OrderTypeSchema.nullable(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaxRule = z.infer<typeof TaxRuleSchema>;

export const PricingModeSchema = z.enum(["inclusive", "exclusive"]);
export type PricingMode = z.infer<typeof PricingModeSchema>;

export const SetTaxSettingsSchema = z.object({
  branchId: z.string().uuid().optional(),
  pricingMode: PricingModeSchema,
});
export type SetTaxSettings = z.infer<typeof SetTaxSettingsSchema>;

export const TaxSettingsSchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid().nullable(),
  pricingMode: PricingModeSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaxSettings = z.infer<typeof TaxSettingsSchema>;

export const CreateServiceChargeSettingSchema = z.object({
  rateBasisPoints: RateBasisPointsSchema,
  branchId: z.string().uuid().optional(),
  orderType: OrderTypeSchema.optional(),
  isTaxable: z.boolean().optional(),
});
export type CreateServiceChargeSetting = z.infer<typeof CreateServiceChargeSettingSchema>;

export const UpdateServiceChargeSettingSchema = z.object({
  rateBasisPoints: RateBasisPointsSchema.optional(),
  branchId: z.string().uuid().nullable().optional(),
  orderType: OrderTypeSchema.nullable().optional(),
  isTaxable: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateServiceChargeSetting = z.infer<typeof UpdateServiceChargeSettingSchema>;

export const ServiceChargeSettingSchema = z.object({
  id: z.string().uuid(),
  rateBasisPoints: z.number().int(),
  branchId: z.string().uuid().nullable(),
  orderType: OrderTypeSchema.nullable(),
  isTaxable: z.boolean(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ServiceChargeSetting = z.infer<typeof ServiceChargeSettingSchema>;

export const PreviewChargesQuerySchema = z.object({
  branchId: z.string().uuid(),
  orderType: OrderTypeSchema,
  subtotalMinor: MinorUnitsSchema,
  currency: z.string().length(3),
});
export type PreviewChargesQuery = z.infer<typeof PreviewChargesQuerySchema>;

export const AppliedTaxRuleSchema = z.object({ name: z.string(), rateBasisPoints: z.number().int() });
export type AppliedTaxRule = z.infer<typeof AppliedTaxRuleSchema>;

/**
 * The result of composing the configured tax/service-charge settings with
 * packages/domain's pure calculation functions for one subtotal — a preview,
 * not a persisted record. See TaxCalculationService for the documented
 * inclusive/exclusive and taxable-service-charge semantics this encodes.
 */
export const PreviewedChargesSchema = z.object({
  pricingMode: PricingModeSchema,
  appliedTaxRules: z.array(AppliedTaxRuleSchema),
  taxRateBasisPoints: z.number().int(),
  serviceChargeRateBasisPoints: z.number().int().nullable(),
  serviceChargeIsTaxable: z.boolean().nullable(),
  subtotalMinor: MinorUnitsSchema,
  serviceChargeMinor: MinorUnitsSchema,
  taxBaseMinor: MinorUnitsSchema,
  taxMinor: MinorUnitsSchema,
  totalMinor: MinorUnitsSchema,
});
export type PreviewedCharges = z.infer<typeof PreviewedChargesSchema>;
