import { sql } from "drizzle-orm";
import { check, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { diningTables } from "./dining-tables.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { users } from "./users.js";

/**
 * P2-09: the order header — dine-in, takeaway and delivery share this one
 * row shape, with `orderType` driving the one real structural difference
 * this task owns: a dine-in order must reference a table, the other two
 * must not. The CHECK constraint below is the real guarantee (same
 * defense-in-depth reasoning as RLS being a second barrier beyond app-level
 * filtering) — OrdersService enforces the same rule before insert, but a
 * stray write that skipped the service would still be caught here.
 *
 * `status` (open/held/closed/cancelled — "held" added by P2-14 for a parked
 * ticket) has no DB-level transition constraint; packages/domain's state
 * machine (P2-13) is the real guard, enforced by OrdersService before every
 * update.
 *
 * No line items here — "the cart" (quantities, modifiers, notes, seat/course
 * assignment) is P2-12's job specifically; this task is about the order's
 * type and lifecycle shape, not its contents.
 */
export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    orderType: text("order_type", { enum: ["dine_in", "takeaway", "delivery"] }).notNull(),
    tableId: uuid("table_id").references(() => diningTables.id),
    status: text("status", { enum: ["open", "held", "closed", "cancelled"] })
      .notNull()
      .default("open"),
    currency: text("currency").notNull(),
    openedByUserId: uuid("opened_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "orders_table_id_matches_order_type",
      sql`(${table.orderType} = 'dine_in' AND ${table.tableId} IS NOT NULL) OR (${table.orderType} <> 'dine_in' AND ${table.tableId} IS NULL)`,
    ),
    // P2-16: the real, DB-enforced guard behind "a table has at most one
    // occupying order" — OrdersService's own pre-check (requireFreeTableInBranch)
    // reads then decides, which two concurrent terminals can both pass before
    // either writes. This index is what actually makes the second write fail
    // instead of silently landing two orders on the same table.
    uniqueIndex("orders_table_occupancy_idx")
      .on(table.tableId)
      .where(sql`${table.tableId} IS NOT NULL AND ${table.status} IN ('open', 'held')`),
    pgPolicy("orders_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
