import { sql } from "drizzle-orm";
import { bigint, pgPolicy, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { priceLists } from "./price-lists.js";
import { productVariants } from "./product-variants.js";
import { products } from "./products.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P2-04: one priced line within a price list — exactly one of productId/
 * variantId is set (enforced at the service layer, same reason every other
 * cross-table reference in this schema is checked there rather than left to
 * the FK alone: RLS doesn't protect FK checks, see products.ts). Which one a
 * caller resolves against is the caller's own choice (a specific variant was
 * selected, or the bare product was) — PriceResolutionService looks up
 * exactly the reference it's given, with no precedence between the two.
 *
 * unitPriceMinor is a bigint, never a float (rule 5) — the same
 * packages/domain Money representation every other amount in this codebase
 * uses, constructed from this column plus price_lists.currency.
 *
 * Two separate partial unique indexes, not one composite index, because a
 * plain UNIQUE(price_list_id, product_id, variant_id) would never actually
 * catch a duplicate product-only entry: SQL treats every NULL as distinct
 * from every other NULL, so two rows with the same product_id and both
 * variant_id = NULL wouldn't violate a composite constraint at all.
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
    unitPriceMinor: bigint("unit_price_minor", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("price_list_items_list_product_idx").on(table.priceListId, table.productId).where(sql`${table.variantId} IS NULL`),
    uniqueIndex("price_list_items_list_variant_idx").on(table.priceListId, table.variantId).where(sql`${table.variantId} IS NOT NULL`),
    pgPolicy("price_list_items_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
