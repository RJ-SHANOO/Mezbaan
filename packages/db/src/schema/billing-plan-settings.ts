import { sql } from "drizzle-orm";
import { bigint, check, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { isSuperAdmin, tenantMatch } from "./rls.js";

/**
 * P3-36: one row per restaurant, same "settings table" shape as
 * feature-flags.ts (select is any member of the restaurant — transparency
 * about their own billing; insert/update/delete is super-admin-only, the
 * same split restaurants.ts's delete and feature_flags already use). A
 * missing row means the default: pure commission, billed monthly — no
 * code path needs to pre-populate every restaurant with one at signup.
 *
 * Deliberately NOT locked the way restaurants.commissionRateBasisPoints is
 * (rule 7) — the rate itself stays locked there; `fixedFeeMinor` and
 * `billingCycle` are a separate, explicitly configurable dimension a Super
 * Admin can change at any time (the task's own wording). P3-37's
 * CommissionRun is what actually snapshots whichever fee/cycle was in
 * effect onto each run, the same way P3-34's CommissionService snapshots
 * the rate onto each entry — so a later change here still never alters a
 * run that already happened.
 */
export const billingPlanSettings = pgTable(
  "billing_plan_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    planType: text("plan_type", { enum: ["commission_only", "hybrid"] }).notNull().default("commission_only"),
    // Only set (both together) when planType is "hybrid" — enforced below
    // by a CHECK, same style as orders.ts's discount/table-id pair.
    fixedFeeMinor: bigint("fixed_fee_minor", { mode: "bigint" }),
    fixedFeeCurrency: text("fixed_fee_currency"),
    billingCycle: text("billing_cycle", { enum: ["weekly", "biweekly", "monthly", "quarterly"] }).notNull().default("monthly"),
    // No FK to users: the expected actor is a super-admin session, same
    // reasoning as feature_flags.updatedByUserId.
    updatedByUserId: uuid("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("billing_plan_settings_restaurant_idx").on(table.restaurantId),
    check(
      "billing_plan_settings_hybrid_fee_pair",
      sql`(${table.planType} = 'hybrid' AND ${table.fixedFeeMinor} IS NOT NULL AND ${table.fixedFeeCurrency} IS NOT NULL) OR (${table.planType} = 'commission_only' AND ${table.fixedFeeMinor} IS NULL AND ${table.fixedFeeCurrency} IS NULL)`,
    ),
    pgPolicy("billing_plan_settings_select", {
      for: "select",
      using: tenantMatch,
    }),
    pgPolicy("billing_plan_settings_insert", {
      for: "insert",
      withCheck: isSuperAdmin,
    }),
    pgPolicy("billing_plan_settings_update", {
      for: "update",
      using: isSuperAdmin,
      withCheck: isSuperAdmin,
    }),
    pgPolicy("billing_plan_settings_delete", {
      for: "delete",
      using: isSuperAdmin,
    }),
  ],
).enableRLS();
