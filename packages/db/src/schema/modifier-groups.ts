import { integer, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P2-02: a reusable set of choices (e.g. "Choose a sauce", "Toppings") —
 * restaurant-level, not tied to one product, since the same group is normally
 * offered on many products (every burger offers the same sauce choices).
 * `product_modifier_groups.ts` is the join that actually attaches one to a
 * product.
 *
 * minSelections/maxSelections together express both "required or optional" and
 * "min/max choices" in one pair rather than a separate boolean: 0 minimum means
 * optional (the customer can skip the group entirely), >=1 means required.
 * maxSelections is nullable — no cap — for groups like "add any toppings you
 * want."
 */
export const modifierGroups = pgTable(
  "modifier_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    name: text("name").notNull(),
    minSelections: integer("min_selections").notNull().default(0),
    maxSelections: integer("max_selections"),
    sortOrder: integer("sort_order").notNull().default(0),
    status: text("status", { enum: ["active", "inactive"] })
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("modifier_groups_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
