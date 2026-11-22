import { pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P3-08: a unit of measure (e.g. "Kilogram"/"kg", "Carton"/"ctn", "Piece"/
 * "pc") — restaurant-defined, same convention as discount/void/refund
 * reason codes rather than a hardcoded global enum, since restaurants
 * measure stock in whatever units their own suppliers and recipes use.
 * `abbreviation` is unique per restaurant (two units can't both claim
 * "kg") so it can double as a stable, human-typeable reference; `name` has
 * no such constraint — nothing stops two units sharing a display name,
 * though nothing sensible would want to.
 */
export const units = pgTable(
  "units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    name: text("name").notNull(),
    abbreviation: text("abbreviation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("units_restaurant_abbreviation_idx").on(table.restaurantId, table.abbreviation),
    pgPolicy("units_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
