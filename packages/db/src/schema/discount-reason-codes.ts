import { boolean, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P2-22: the fixed set of reasons a restaurant allows for a discount — rule
 * 6 ("discounts are always... given a reason") means a free-text reason
 * isn't enough on its own for reporting purposes; a cashier picks from this
 * restaurant-defined list instead. Deliberately an inclusion list (unlike
 * payment_method_settings' exclusion-list convention): there's no sensible
 * universal default reason set to fall back to, so a restaurant must define
 * at least one before any discount can be applied at all.
 */
export const discountReasonCodes = pgTable(
  "discount_reason_codes",
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
    uniqueIndex("discount_reason_codes_restaurant_code_idx").on(table.restaurantId, table.code),
    pgPolicy("discount_reason_codes_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
