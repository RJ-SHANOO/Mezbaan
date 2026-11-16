import { boolean, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P2-23: the fixed set of reasons a restaurant allows for voiding an order
 * item — same rule 6 reasoning and same inclusion-list convention as P2-22's
 * discount_reason_codes (a separate table, not a shared polymorphic one:
 * void reasons and discount reasons name genuinely different things —
 * "kitchen error," "customer changed mind" vs. "loyalty," "complaint" — and
 * keeping them apart cost nothing worth avoiding here).
 */
export const voidReasonCodes = pgTable(
  "void_reason_codes",
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
    uniqueIndex("void_reason_codes_restaurant_code_idx").on(table.restaurantId, table.code),
    pgPolicy("void_reason_codes_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
