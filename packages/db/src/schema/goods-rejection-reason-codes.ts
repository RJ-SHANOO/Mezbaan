import { boolean, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P3-22: the fixed set of reasons a restaurant allows for rejecting part
 * of a delivery (e.g. "damaged," "wrong item," "expired on arrival") —
 * same rule 6 reasoning and same inclusion-list convention as void/
 * discount/refund/cash-movement reason codes, a separate table rather
 * than a shared polymorphic one for the same reasons those already are.
 */
export const goodsRejectionReasonCodes = pgTable(
  "goods_rejection_reason_codes",
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
    uniqueIndex("goods_rejection_reason_codes_restaurant_code_idx").on(table.restaurantId, table.code),
    pgPolicy("goods_rejection_reason_codes_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
