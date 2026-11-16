import { date, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { users } from "./users.js";

/**
 * P2-30: one row per branch per calendar business day, in the branch's own
 * timezone (not server UTC — "business day" is a local-time concept for a
 * physical restaurant). A day with no row at all is implicitly open — only
 * closing ever writes a row; there's no separate "open" action to call.
 * Mutable like `shifts` (P2-27), not append-only: a day legitimately
 * transitions open→closed in place.
 */
export const businessDays = pgTable(
  "business_days",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    status: text("status", { enum: ["open", "closed"] }).notNull().default("open"),
    closedByUserId: uuid("closed_by_user_id").references(() => users.id),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("business_days_branch_date_idx").on(table.branchId, table.businessDate),
    pgPolicy("business_days_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
