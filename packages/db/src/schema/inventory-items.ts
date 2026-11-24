import { sql } from "drizzle-orm";
import { pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { inventoryCategories } from "./inventory-categories.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { units } from "./units.js";

/**
 * P3-07: a raw ingredient or stock item (e.g. "Tomatoes", "Flour",
 * "Takeaway Box, Large") — distinct from products.ts's sellable menu
 * items. SKU and barcode are each unique per restaurant when set, but both
 * optional, same partial-unique-per-restaurant convention as products.ts —
 * two items with no barcode must never collide just because both are NULL.
 *
 * P3-08: `baseUnitId` is the unit the stock ledger will always record this
 * item's quantities in (e.g. "piece" for eggs, "g" for flour) — every
 * other unit this item uses converts to it via
 * inventory_item_unit_conversions, a star shape centered on this column.
 * `purchaseUnitId` is the unit purchase orders (P3-21) will default to
 * (e.g. "carton" for eggs bought a dozen cartons at a time); null means
 * "same as the base unit," not "unset" — not every item is bought in a
 * different unit than it's stocked in.
 *
 * P3-15: `itemType` distinguishes a raw, purchased ingredient from a
 * semi-finished one — a sauce, marinated meat, anything made in-house
 * rather than bought — which is still just an ordinary inventory item
 * (it has its own stock level, moves through the same ledger, uses the
 * "production" movement type that's existed since P3-09) except that it
 * *also* has its own recipe (recipes.ts's fourth owner kind, `itemId`)
 * saying what it's made from. RecipesService enforces that only a
 * "semi_finished" item may own a recipe — a plain CHECK constraint can't
 * reach across tables to verify that, so it's a service-layer rule.
 */
export const inventoryItems = pgTable(
  "inventory_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => inventoryCategories.id),
    name: text("name").notNull(),
    sku: text("sku"),
    barcode: text("barcode"),
    baseUnitId: uuid("base_unit_id")
      .notNull()
      .references(() => units.id),
    purchaseUnitId: uuid("purchase_unit_id").references(() => units.id),
    itemType: text("item_type", { enum: ["raw", "semi_finished"] })
      .notNull()
      .default("raw"),
    status: text("status", { enum: ["active", "inactive"] })
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("inventory_items_restaurant_sku_idx").on(table.restaurantId, table.sku).where(sql`${table.sku} IS NOT NULL`),
    uniqueIndex("inventory_items_restaurant_barcode_idx")
      .on(table.restaurantId, table.barcode)
      .where(sql`${table.barcode} IS NOT NULL`),
    pgPolicy("inventory_items_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
