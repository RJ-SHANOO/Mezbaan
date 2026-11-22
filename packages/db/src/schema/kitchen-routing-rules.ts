import { sql } from "drizzle-orm";
import { pgPolicy, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { categories } from "./categories.js";
import { kitchenStations } from "./kitchen-stations.js";
import { products } from "./products.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P3-01: routes a category or product to a kitchen station at one branch.
 * Exactly one of categoryId/productId is set (enforced at the service layer,
 * same reason as product_stock_status — RLS doesn't protect a bare FK/XOR
 * check), with the same two-partial-unique-index shape: at most one rule per
 * branch+category and one rule per branch+product, so two rules can never
 * disagree about where the same thing goes. A product-level rule overrides
 * its category's rule (resolved by KitchenRoutingRulesService, not here).
 */
export const kitchenRoutingRules = pgTable(
  "kitchen_routing_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    stationId: uuid("station_id")
      .notNull()
      .references(() => kitchenStations.id),
    categoryId: uuid("category_id").references(() => categories.id),
    productId: uuid("product_id").references(() => products.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("kitchen_routing_rules_branch_category_idx").on(table.branchId, table.categoryId).where(sql`${table.categoryId} IS NOT NULL`),
    uniqueIndex("kitchen_routing_rules_branch_product_idx").on(table.branchId, table.productId).where(sql`${table.productId} IS NOT NULL`),
    pgPolicy("kitchen_routing_rules_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
