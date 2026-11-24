import { pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { storageLocations } from "./storage-locations.js";
import { users } from "./users.js";

/**
 * P3-26: a count session at one storage location — "full" enumerates
 * every item stock_levels already tracks there (StockCountsService.start);
 * "cycle" is a caller-chosen subset. Mutable, not append-only: a count
 * is a working document moving through its own lifecycle
 * (in_progress -> submitted), same precedent as purchase_orders.ts/
 * shifts.ts, not a completed financial fact.
 *
 * "submitted" only means every line has a blind count entered and the
 * variance against what was expected is now computable; nothing in this
 * task (P3-26) ever touches stock_ledger/stock_levels. P3-27 adds the
 * third state, "approved" — ManagerPinService-gated, same as a refund
 * (no own-authority tier at all: a count, by nature, has already been
 * fully entered before anyone reviews it, so there's no smaller-amount
 * exception to carve out the way a discount has). Approving is the one
 * moment stock actually moves: one "count" stock_ledger row per line
 * whose countedQuantity differs from its expectedQuantity.
 */
export const stockCounts = pgTable(
  "stock_counts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    storageLocationId: uuid("storage_location_id")
      .notNull()
      .references(() => storageLocations.id),
    countType: text("count_type", { enum: ["full", "cycle"] }).notNull(),
    status: text("status", { enum: ["in_progress", "submitted", "approved"] })
      .notNull()
      .default("in_progress"),
    startedByUserId: uuid("started_by_user_id")
      .notNull()
      .references(() => users.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("stock_counts_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
