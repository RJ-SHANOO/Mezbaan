import { boolean, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P3-24: the fixed set of reasons a restaurant allows for sending
 * already-accepted stock back to a supplier (e.g. "found damaged after
 * inspection," "supplier agreed to take back excess") — a separate
 * concept from goods_rejection_reason_codes.ts (P3-22), which is about
 * refusing a delivery at the dock before it's ever accepted into stock.
 * Same inclusion-list convention as every other reason-code table in this
 * project.
 */
export const purchaseReturnReasonCodes = pgTable(
  "purchase_return_reason_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    code: text("code").notNull(),
    label: text("label").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("purchase_return_reason_codes_restaurant_code_idx").on(table.restaurantId, table.code),
    pgPolicy("purchase_return_reason_codes_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
