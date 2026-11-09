import { boolean, pgPolicy, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { products } from "./products.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P2-01's "availability by branch" — an exclusion list, same convention as
 * feature_flags (P1-23): a product with no row here is available at every one
 * of its restaurant's branches, which is the common case (most products are on
 * every branch's menu). A row only exists to record an explicit per-branch
 * override, and `available` carries the override's actual value rather than the
 * table existing only to mean "unavailable" — so a branch can be turned back on
 * without deleting the row (and losing whatever audit trail points at it).
 */
export const productBranchAvailability = pgTable(
  "product_branch_availability",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    available: boolean("available").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("product_branch_availability_product_branch_idx").on(table.productId, table.branchId),
    pgPolicy("product_branch_availability_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
