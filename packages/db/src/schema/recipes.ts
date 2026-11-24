import { sql } from "drizzle-orm";
import { check, integer, pgPolicy, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { inventoryItems } from "./inventory-items.js";
import { modifierOptions } from "./modifier-options.js";
import { productVariants } from "./product-variants.js";
import { products } from "./products.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P3-13: what a sellable product (or variant) is made of. P3-14 extends
 * this to modifier options too (e.g. "Extra Cheese" adding mozzarella on
 * top of whatever the base product's own recipe already consumes), and
 * P3-15 extends it again to a semi-finished inventory item itself (e.g.
 * "Marinara Sauce" has its own recipe saying what it's made from) —
 * `semiFinishedItemId` is deliberately not named `itemId` to avoid
 * reading like recipe_items.ts's own `itemId` (an ingredient *used*,
 * not the thing *being defined*). Same shape, same recipe_items.ts lines,
 * just a fourth kind of owner. RecipesService additionally checks that
 * whatever inventory_items row this points at is actually
 * `itemType: "semi_finished"` — a CHECK constraint can't reach across
 * tables to verify that, so it's a service-layer rule.
 *
 * Exactly one of productId/variantId/modifierOptionId/semiFinishedItemId
 * is set (same convention and same reasoning as order_items.ts/
 * price_list_items.ts — which one a caller is defining is its own
 * choice, enforced with a CHECK constraint the same way). At most one
 * recipe per product, variant, modifier option and semi-finished item
 * (the four partial unique indexes below) — unambiguous, not a
 * competing set to choose between.
 *
 * Computing a sale's *total* consumption — the base recipe plus every
 * selected modifier's own recipe, recursively expanding any semi-finished
 * ingredient into ITS OWN recipe — is P3-17's job specifically (auto-
 * deducting from a synced sale); this task only defines the rules, the
 * same "primitive now, consumer later" split as every other recipe-
 * adjacent task so far. A recipe that directly includes its own
 * semi-finished item as an ingredient is rejected by RecipesService
 * (an obvious, cheap self-reference check); a *deeper* cycle — sauce A
 * uses sauce B, sauce B uses sauce A — is not caught here. That's a
 * documented gap for whichever later task actually walks the ingredient
 * graph (P3-16's production batches or P3-17/19's costing) to guard
 * against, not silently dropped.
 *
 * Not immutable/published the way price_lists.ts is — createOrReplace
 * still fully replaces recipe_items in place each time, no draft/publish
 * step, no history of old recipe_items content kept. `version` (P3-19) is
 * a lighter-weight compromise: a plain counter bumped on every
 * createOrReplace call, just enough for a sale to stamp "which edition of
 * this recipe produced this consumption" (order_item_food_costs.ts) onto
 * its own history, without rebuilding price_lists' whole draft/publish
 * machinery for a requirement that never asked for it — recovering a past
 * version's exact ingredient list isn't something this task needs, only
 * recognizing that the version changed.
 */
export const recipes = pgTable(
  "recipes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    productId: uuid("product_id").references(() => products.id),
    variantId: uuid("variant_id").references(() => productVariants.id),
    modifierOptionId: uuid("modifier_option_id").references(() => modifierOptions.id),
    semiFinishedItemId: uuid("semi_finished_item_id").references(() => inventoryItems.id),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "recipes_exactly_one_owner",
      sql`(
        (CASE WHEN ${table.productId} IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN ${table.variantId} IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN ${table.modifierOptionId} IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN ${table.semiFinishedItemId} IS NOT NULL THEN 1 ELSE 0 END)
      ) = 1`,
    ),
    uniqueIndex("recipes_restaurant_product_idx").on(table.restaurantId, table.productId).where(sql`${table.productId} IS NOT NULL`),
    uniqueIndex("recipes_restaurant_variant_idx").on(table.restaurantId, table.variantId).where(sql`${table.variantId} IS NOT NULL`),
    uniqueIndex("recipes_restaurant_modifier_option_idx").on(table.restaurantId, table.modifierOptionId).where(sql`${table.modifierOptionId} IS NOT NULL`),
    uniqueIndex("recipes_restaurant_semi_finished_item_idx").on(table.restaurantId, table.semiFinishedItemId).where(sql`${table.semiFinishedItemId} IS NOT NULL`),
    pgPolicy("recipes_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
