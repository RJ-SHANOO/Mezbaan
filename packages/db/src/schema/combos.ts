import { integer, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P2-03: a combo/deal (e.g. "Burger Meal Deal") — a bundle sold as one item.
 * What's actually in it lives in combo-slots.ts/combo-slot-items.ts. No price
 * here either, same rule-3/P2-04 reasoning as every other catalog entity.
 */
export const combos = pgTable(
  "combos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    name: text("name").notNull(),
    imageUrl: text("image_url"),
    sortOrder: integer("sort_order").notNull().default(0),
    status: text("status", { enum: ["active", "inactive"] })
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("combos_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
