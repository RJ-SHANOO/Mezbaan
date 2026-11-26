import { z } from "zod";
import { BillingPlanSchema } from "./billing-plan.js";
import { CurrencyCodeSchema } from "./currency.js";

const MINOR_UNITS_PATTERN = /^-?\d+$/;
const MinorUnitsSchema = z.string().regex(MINOR_UNITS_PATTERN, "must be an integer string");

export const RestaurantStatusSchema = z.enum(["active", "suspended"]);
export type RestaurantStatus = z.infer<typeof RestaurantStatusSchema>;

/** P3-39: the Super Admin restaurant list — deliberately light (no
 * per-restaurant financial aggregation): branch/device counts are cheap
 * joins, but outstanding settlement balance is not something to compute
 * for every row of a list — that lives only on RestaurantDetailSchema,
 * the "support tool" single-restaurant lookup. Not cursor-paginated —
 * section 6's own target (100-1,000 restaurants) is a bounded,
 * tenant-count list, the same "bounded by restaurant/branch size, not
 * transaction volume" category P2-46 already scoped cursor pagination
 * away from (catalog/config lists), not an ever-growing one. */
export const RestaurantSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  status: RestaurantStatusSchema,
  branchCount: z.number().int(),
  deviceCount: z.number().int(),
  billingPlan: BillingPlanSchema,
  createdAt: z.string(),
});
export type RestaurantSummary = z.infer<typeof RestaurantSummarySchema>;

export const RestaurantBranchSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: z.enum(["active", "inactive"]),
});
export type RestaurantBranchSummary = z.infer<typeof RestaurantBranchSummarySchema>;

export const RestaurantDeviceSummarySchema = z.object({
  id: z.string().uuid(),
  branchId: z.string().uuid(),
  label: z.string(),
  deviceType: z.enum(["pos_terminal", "kitchen_display", "tablet", "other"]),
  status: z.enum(["active", "revoked"]),
  lastSeenAt: z.string().nullable(),
});
export type RestaurantDeviceSummary = z.infer<typeof RestaurantDeviceSummarySchema>;

export const OutstandingSettlementSchema = z.object({
  currency: CurrencyCodeSchema,
  remainingAmountMinor: MinorUnitsSchema,
});
export type OutstandingSettlement = z.infer<typeof OutstandingSettlementSchema>;

/** The full support-tool lookup: everything a platform-ops session needs
 * to answer "what's going on with this restaurant" in one call. Grouped
 * by currency rather than a single scalar — almost always exactly one
 * currency in practice, but nothing here assumes that (same reasoning
 * commission-runs.ts groups by currency rather than guessing at "the"
 * one). */
export const RestaurantDetailSchema = RestaurantSummarySchema.extend({
  branches: z.array(RestaurantBranchSummarySchema),
  devices: z.array(RestaurantDeviceSummarySchema),
  outstandingSettlements: z.array(OutstandingSettlementSchema),
});
export type RestaurantDetail = z.infer<typeof RestaurantDetailSchema>;

export const SetRestaurantStatusSchema = z.object({
  status: RestaurantStatusSchema,
});
export type SetRestaurantStatus = z.infer<typeof SetRestaurantStatusSchema>;

export const PlatformRevenueQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type PlatformRevenueQuery = z.infer<typeof PlatformRevenueQuerySchema>;

export const PlatformRevenueByCurrencySchema = z.object({
  currency: CurrencyCodeSchema,
  totalAmountMinor: MinorUnitsSchema,
});
export type PlatformRevenueByCurrency = z.infer<typeof PlatformRevenueByCurrencySchema>;

export const PlatformRevenueSchema = z.object({
  from: z.string().nullable(),
  to: z.string().nullable(),
  byCurrency: z.array(PlatformRevenueByCurrencySchema),
});
export type PlatformRevenue = z.infer<typeof PlatformRevenueSchema>;
