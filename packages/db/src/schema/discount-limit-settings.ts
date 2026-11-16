import { bigint, integer, pgPolicy, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { users } from "./users.js";

/**
 * P2-22: how much discount a cashier's own pos.sell authority covers before
 * a manager has to approve it with their PIN (ManagerPinService, P1-13 —
 * this task is the first real sensitive-action flow to actually wire into
 * it). One row per restaurant (no branch scoping — nothing in this task
 * calls for a per-branch limit). Both caps are nullable, and nullable means
 * "no auto-approval at all" for that discount type — the safer default
 * given rule 6's "never under-report a sale," not "unlimited." A restaurant
 * that hasn't configured this yet requires manager approval for every
 * discount, same reasoning tax_settings defaults to the more conservative
 * "exclusive" pricing mode rather than guessing in the business's favor.
 */
export const discountLimitSettings = pgTable(
  "discount_limit_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    maxUnapprovedPercentBasisPoints: integer("max_unapproved_percent_basis_points"),
    maxUnapprovedAmountMinor: bigint("max_unapproved_amount_minor", { mode: "bigint" }),
    updatedByUserId: uuid("updated_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("discount_limit_settings_restaurant_idx").on(table.restaurantId),
    pgPolicy("discount_limit_settings_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
