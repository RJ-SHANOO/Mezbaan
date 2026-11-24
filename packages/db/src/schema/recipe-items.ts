import { sql } from "drizzle-orm";
import { check, numeric, pgPolicy, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { inventoryItems } from "./inventory-items.js";
import { recipes } from "./recipes.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { units } from "./units.js";

/**
 * P3-13: one ingredient line within a recipe — how much of `itemId`, in
 * `unitId`'s own unit (not necessarily the item's base unit; a recipe can
 * call for "50 g" even if that item is stocked in kg — convert via
 * packages/domain's convertQuantity when actually deducting stock), goes
 * into one unit of the recipe's product/variant.
 *
 * `yieldPercent` is this *ingredient's* own prep loss (e.g. potatoes lose
 * some weight to peeling), not a property of the recipe as a whole —
 * different ingredients in the same dish can have completely different
 * yields, so it lives on the line, not on recipes.ts. 100 means no loss;
 * packages/domain's requiredRawQuantity is how a caller turns this line's
 * `quantity` (how much usable product the recipe needs) into how much raw
 * stock to actually pull.
 */
export const recipeItems = pgTable(
  "recipe_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    recipeId: uuid("recipe_id")
      .notNull()
      .references(() => recipes.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => inventoryItems.id),
    quantity: numeric("quantity", { mode: "number", precision: 18, scale: 6 }).notNull(),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id),
    yieldPercent: numeric("yield_percent", { mode: "number", precision: 5, scale: 2 }).notNull().default(100),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("recipe_items_quantity_positive", sql`${table.quantity} > 0`),
    check("recipe_items_yield_percent_in_range", sql`${table.yieldPercent} > 0 AND ${table.yieldPercent} <= 100`),
    pgPolicy("recipe_items_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
