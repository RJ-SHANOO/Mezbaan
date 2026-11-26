import { sql } from "drizzle-orm";
import { bigint, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P3-37: one settled billing-cycle period, ever — append-only (rule 4's
 * convention, same enforcement as commission_entries; UPDATE/DELETE
 * revoked in app-role.ts). CommissionRunService never recomputes or edits
 * a run already written here; a correction would be a new compensating row
 * for a later period, the same spirit as every other append-only table in
 * this codebase.
 *
 * `planType`/`billingCycle`/the fee amount are all snapshotted at the
 * moment the run is created, not looked up fresh later — same rule-7
 * reasoning as commission_entries.rateBasisPoints: a Super Admin changing
 * a restaurant's plan tomorrow must never alter what a past run already
 * says was owed.
 *
 * `commissionAmountMinor` is the period's net commission (SUM of
 * commission_entries.amountMinor — charges and reversals together,
 * already signed); `fixedFeeAmountMinor` is 0 unless the plan was hybrid
 * for this period. One row per (restaurant, period, currency) — almost
 * always exactly one currency per restaurant in practice, but nothing
 * here assumes that; CommissionRunService groups by currency so a mixed
 * period produces one row per currency actually seen rather than guessing
 * at a single "the" currency to force everything into.
 *
 * Idempotency is actually enforced by CommissionRunService's own
 * sequential cursor (commission-run-cursors.ts) — a period already past
 * the cursor is never reprocessed — this unique index is the same second
 * barrier every other idempotent write in this codebase has (e.g.
 * commission_entries.paymentId).
 */
export const commissionRuns = pgTable(
  "commission_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    planType: text("plan_type", { enum: ["commission_only", "hybrid"] }).notNull(),
    billingCycle: text("billing_cycle", { enum: ["weekly", "biweekly", "monthly", "quarterly"] }).notNull(),
    commissionAmountMinor: bigint("commission_amount_minor", { mode: "bigint" }).notNull(),
    fixedFeeAmountMinor: bigint("fixed_fee_amount_minor", { mode: "bigint" }).notNull().default(sql`0`),
    totalAmountMinor: bigint("total_amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("commission_runs_restaurant_period_currency_idx").on(table.restaurantId, table.periodStart, table.periodEnd, table.currency),
    pgPolicy("commission_runs_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
