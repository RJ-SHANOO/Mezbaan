import { sql } from "drizzle-orm";
import { integer, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { categories } from "./categories.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P2-01: products. SKU and barcode are each unique per restaurant when set, but
 * both are optional (a brand-new product may not have either assigned yet), so
 * the uniqueness is a partial index — two products with no barcode must never
 * collide with each other just because both are NULL.
 *
 * Deliberately no price field here — rule 3 and P2-04 ("versioned price lists
 * with branch, order type and time-based pricing") own pricing; a product's own
 * row only ever describes the product itself, never what it costs.
 */
export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
    name: text("name").notNull(),
    sku: text("sku"),
    barcode: text("barcode"),
    sortOrder: integer("sort_order").notNull().default(0),
    status: text("status", { enum: ["active", "inactive"] })
      .notNull()
      .default("active"),
    // Same "reference only, real upload pipeline is P2-44" note as categories.ts.
    imageUrl: text("image_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("products_restaurant_sku_idx").on(table.restaurantId, table.sku).where(sql`${table.sku} IS NOT NULL`),
    uniqueIndex("products_restaurant_barcode_idx")
      .on(table.restaurantId, table.barcode)
      .where(sql`${table.barcode} IS NOT NULL`),
    pgPolicy("products_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
