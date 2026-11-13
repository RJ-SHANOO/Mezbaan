import { sql } from "drizzle-orm";
import { bigint, pgPolicy, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { modifierOptions } from "./modifier-options.js";
import { priceLists } from "./price-lists.js";
import { productVariants } from "./product-variants.js";
import { products } from "./products.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P2-04: one priced line within a price list — exactly one of productId/
 * variantId/modifierOptionId is set (enforced at the service layer, same
 * reason every other cross-table reference in this schema is checked there
 * rather than left to the FK alone: RLS doesn't protect FK checks, see
 * products.ts). Which one a caller resolves against is the caller's own
 * choice — PriceResolutionService looks up exactly the reference it's
 * given, with no precedence between them.
 *
 * modifierOptionId (P2-12) completes what modifier-options.ts already said
 * was the plan: "what an option costs extra is a price-list concern" — the
 * cart is the first real consumer that needs a modifier's price, so this is
 * where that promise gets kept, reusing the exact same resolution machinery
 * rather than inventing a separate modifier-pricing path.
 *
 * unitPriceMinor is a bigint, never a float (rule 5) — the same
 * packages/domain Money representation every other amount in this codebase
 * uses, constructed from this column plus price_lists.currency.
 *
 * Three separate partial unique indexes, not one composite index, because a
 * plain UNIQUE(price_list_id, product_id, variant_id, modifier_option_id)
 * would never actually catch a duplicate product-only entry: SQL treats
 * every NULL as distinct from every other NULL, so two rows with the same
 * product_id and both other columns NULL wouldn't violate a composite
 * constraint at all.
 */
export const priceListItems = pgTable(
  "price_list_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    priceListId: uuid("price_list_id")
      .notNull()
      .references(() => priceLists.id),
    productId: uuid("product_id").references(() => products.id),
    variantId: uuid("variant_id").references(() => productVariants.id),
    modifierOptionId: uuid("modifier_option_id").references(() => modifierOptions.id),
    unitPriceMinor: bigint("unit_price_minor", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("price_list_items_list_product_idx")
      .on(table.priceListId, table.productId)
      .where(sql`${table.variantId} IS NULL AND ${table.modifierOptionId} IS NULL`),
    uniqueIndex("price_list_items_list_variant_idx")
      .on(table.priceListId, table.variantId)
      .where(sql`${table.variantId} IS NOT NULL`),
    uniqueIndex("price_list_items_list_modifier_option_idx")
      .on(table.priceListId, table.modifierOptionId)
      .where(sql`${table.modifierOptionId} IS NOT NULL`),
    pgPolicy("price_list_items_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
