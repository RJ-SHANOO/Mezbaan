import { sql } from "drizzle-orm";
import { pgPolicy, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { kitchenStations } from "./kitchen-stations.js";
import { orders } from "./orders.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { users } from "./users.js";

/**
 * P3-03: a bumped kitchen ticket. Same exclusion-list convention as
 * product_stock_status/feature_flags — a row's mere existence means
 * "bumped" (done), identified by the same (orderId, firedAt, stationId)
 * composite key KitchenTicketsService already uses to group fired
 * order_items into a ticket (see kitchen-tickets.service.ts); recalling a
 * ticket deletes the row rather than flipping a flag, putting it straight
 * back in the live queue. stationId is nullable (an unrouted ticket), same
 * two-partial-unique-index shape as product_stock_status's product/variant
 * XOR for the same reason — RLS doesn't protect a bare uniqueness rule.
 */
export const kitchenTicketStates = pgTable(
  "kitchen_ticket_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    firedAt: timestamp("fired_at", { withTimezone: true }).notNull(),
    stationId: uuid("station_id").references(() => kitchenStations.id),
    bumpedAt: timestamp("bumped_at", { withTimezone: true }).notNull().defaultNow(),
    bumpedByUserId: uuid("bumped_by_user_id")
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    uniqueIndex("kitchen_ticket_states_order_fired_station_idx")
      .on(table.orderId, table.firedAt, table.stationId)
      .where(sql`${table.stationId} IS NOT NULL`),
    uniqueIndex("kitchen_ticket_states_order_fired_unrouted_idx")
      .on(table.orderId, table.firedAt)
      .where(sql`${table.stationId} IS NULL`),
    pgPolicy("kitchen_ticket_states_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
