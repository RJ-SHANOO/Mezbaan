import { bigint, pgPolicy, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { users } from "./users.js";

/**
 * P3-28: how much an ad-hoc wastage entry's own cost value can be before
 * a manager has to approve it with their PIN — same shape and same
 * reasoning as discount_limit_settings.ts (P2-22). One row per
 * restaurant. `maxUnapprovedCostMinor` nullable means "no auto-approval
 * at all," the safer default, same as a restaurant that hasn't
 * configured this yet requiring approval for every entry rather than
 * guessing a generous limit in the business's favor.
 */
export const wastageLimitSettings = pgTable(
  "wastage_limit_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    maxUnapprovedCostMinor: bigint("max_unapproved_cost_minor", { mode: "bigint" }),
    updatedByUserId: uuid("updated_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("wastage_limit_settings_restaurant_idx").on(table.restaurantId),
    pgPolicy("wastage_limit_settings_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
