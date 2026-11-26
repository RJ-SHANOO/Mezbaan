import { pgPolicy, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P3-37: internal job bookkeeping, not a financial record (same "mutated
 * in place, not append-only" reasoning as outbox.ts) — tracks how far
 * CommissionRunService has advanced through a restaurant's billing
 * periods, independently of whether any given period actually produced a
 * commission_runs row. A commission_only restaurant with zero sales in a
 * period produces no commission_runs row at all (there's nothing to
 * settle, and no restaurant-level default currency exists anywhere in
 * this schema to force a zero-amount row into) — without this cursor,
 * the service would have no way to tell "already looked at this period,
 * nothing happened" from "haven't gotten there yet", and would reprocess
 * the same empty period forever instead of advancing.
 *
 * `lastProcessedPeriodEnd` is always an exact period boundary — the
 * instant one period ends and the next begins — so resuming is just
 * calling `billingPeriodContaining(cycle, lastProcessedPeriodEnd)` again.
 * If a Super Admin changes `billingCycle` later, the cursor still holds:
 * the next period is simply computed under the new cycle from that same
 * instant forward, with no special migration needed.
 */
export const commissionRunCursors = pgTable(
  "commission_run_cursors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    lastProcessedPeriodEnd: timestamp("last_processed_period_end", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("commission_run_cursors_restaurant_idx").on(table.restaurantId),
    pgPolicy("commission_run_cursors_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
