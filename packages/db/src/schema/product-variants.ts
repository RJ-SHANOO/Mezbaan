import { sql } from "drizzle-orm";
import { integer, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { products } from "./products.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P2-02: a product's sellable variations (e.g. Size: Small/Medium/Large). Each
 * variant can carry its own SKU/barcode, same partial-unique-per-restaurant
 * convention as products.ts — two variants with no barcode must never collide
 * just because both are NULL. No price here either, same rule-3/P2-04 reasoning
 * as products: what something costs is a price-list concern, not the catalog
 * entity's own row.
 */
export const productVariants = pgTable(
  "product_variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    name: text("name").notNull(),
    sku: text("sku"),
    barcode: text("barcode"),
    sortOrder: integer("sort_order").notNull().default(0),
    status: text("status", { enum: ["active", "inactive"] })
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("product_variants_restaurant_sku_idx").on(table.restaurantId, table.sku).where(sql`${table.sku} IS NOT NULL`),
    uniqueIndex("product_variants_restaurant_barcode_idx")
      .on(table.restaurantId, table.barcode)
      .where(sql`${table.barcode} IS NOT NULL`),
    pgPolicy("product_variants_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
