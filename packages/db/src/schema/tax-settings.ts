import { sql } from "drizzle-orm";
import { pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P2-05: whether product prices already include tax ("inclusive") or tax is
 * added on top ("exclusive") — packages/domain's calculateInclusiveTax/
 * calculateExclusiveTax do the actual math; this just records which mode
 * applies. Scoped by branch with the same nullable-means-universal
 * convention as tax_rules: at most one restaurant-wide default (branchId
 * NULL) and at most one override per branch, enforced with the same
 * two-partial-unique-index convention as products.sku/barcode (P2-01) — a
 * single composite UNIQUE(restaurant_id, branch_id) wouldn't actually catch
 * a second NULL default, since SQL treats every NULL as distinct from every
 * other NULL.
 */
export const taxSettings = pgTable(
  "tax_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id").references(() => branches.id),
    pricingMode: text("pricing_mode", { enum: ["inclusive", "exclusive"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("tax_settings_restaurant_default_idx").on(table.restaurantId).where(sql`${table.branchId} IS NULL`),
    uniqueIndex("tax_settings_restaurant_branch_idx").on(table.restaurantId, table.branchId).where(sql`${table.branchId} IS NOT NULL`),
    pgPolicy("tax_settings_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
