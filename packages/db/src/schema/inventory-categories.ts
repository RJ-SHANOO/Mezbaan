import { integer, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P3-07: raw-ingredient/stock categories (e.g. "Produce", "Dairy",
 * "Packaging") — a separate tree from categories.ts's menu categories
 * (e.g. "Burgers", "Beverages"). A sellable menu item and the raw stock it's
 * made from are different concepts with different owners (a chef's menu
 * vs. a store manager's stock room), so they get their own category list
 * rather than reusing categories.ts. Restaurant-scoped, same reasoning as
 * categories.ts — an ingredient taxonomy is the same concept across every
 * branch; which branches actually stock which items is inventory_items'
 * own per-branch concern (not this task's scope — storage_locations is a
 * lookup only here, stock levels are P3-10's job).
 */
export const inventoryCategories = pgTable(
  "inventory_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    status: text("status", { enum: ["active", "inactive"] })
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("inventory_categories_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
