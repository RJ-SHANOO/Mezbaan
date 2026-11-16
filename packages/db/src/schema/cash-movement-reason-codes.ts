import { boolean, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P2-28: the fixed set of reasons a restaurant allows for a manual cash
 * movement (cash in or cash out) — same inclusion-list convention as
 * void/discount/refund reason codes, one shared list for both directions
 * since a reason's own label usually already implies which way the cash
 * moved (e.g. "petty cash payout" vs. "owner top-up").
 */
export const cashMovementReasonCodes = pgTable(
  "cash_movement_reason_codes",
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
    uniqueIndex("cash_movement_reason_codes_restaurant_code_idx").on(table.restaurantId, table.code),
    pgPolicy("cash_movement_reason_codes_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
