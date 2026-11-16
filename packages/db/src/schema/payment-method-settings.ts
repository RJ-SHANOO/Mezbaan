import { boolean, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { users } from "./users.js";

/**
 * P2-19: which payment methods a restaurant accepts. Same "absence means
 * enabled" exclusion-list convention as feature_flags — all four methods
 * (cash/card/bank_transfer/wallet) work out of the box for a restaurant that
 * hasn't configured anything at all (rule: never block a sale over a
 * missing setting), and a row only needs to exist to turn one *off*.
 * Restaurant-scoped, not branch-scoped — unlike tax/service-charge rules,
 * nothing in this task calls for per-branch payment method differences, and
 * adding that scoping with no real requirement driving it would be
 * complexity nobody asked for.
 */
export const paymentMethodSettings = pgTable(
  "payment_method_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    method: text("method", { enum: ["cash", "card", "bank_transfer", "wallet"] }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("payment_method_settings_restaurant_method_idx").on(table.restaurantId, table.method),
    pgPolicy("payment_method_settings_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
