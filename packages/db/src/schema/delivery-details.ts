import { pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { deliveryRiders } from "./delivery-riders.js";
import { orders } from "./orders.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P2-10: customer, address and rider/status tracking for one delivery
 * order — a 1:1 extension of `orders` (enforced by the unique index on
 * orderId), not a reusable customer profile. A real, cross-order Customer
 * entity with order history is P4-04's job specifically ("Build customer
 * records, order history and optional loyalty points"); this is just the
 * delivery-specific capture this task asks for, scoped to one order.
 *
 * `riderId` is nullable — a delivery order can exist before a rider is
 * assigned (captured at order time, assigned later once someone's free).
 * `deliveryStatus` is a plain settable field with no transition validation,
 * same convention as orders.status and dining_tables.status before any
 * state machine existed for either — DeliveryDetailsService does apply one
 * sensible default (assigning a rider bumps pending -> assigned) but that's
 * a side effect, not an enforced rule.
 *
 * Whether this row's existence matches its order's orderType = 'delivery'
 * is checked in DeliveryDetailsService, not a DB CHECK constraint — unlike
 * orders.tableId vs orderType (one table, enforceable in SQL), this is a
 * cross-table invariant Postgres CHECK constraints can't express.
 */
export const deliveryDetails = pgTable(
  "delivery_details",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    customerName: text("customer_name").notNull(),
    customerPhone: text("customer_phone").notNull(),
    addressLine1: text("address_line_1").notNull(),
    addressLine2: text("address_line_2"),
    city: text("city"),
    deliveryInstructions: text("delivery_instructions"),
    riderId: uuid("rider_id").references(() => deliveryRiders.id),
    deliveryStatus: text("delivery_status", { enum: ["pending", "assigned", "out_for_delivery", "delivered", "failed"] })
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("delivery_details_order_id_idx").on(table.orderId),
    pgPolicy("delivery_details_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
