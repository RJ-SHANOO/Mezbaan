import { sql } from "drizzle-orm";
import { boolean, integer, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P3-07: a physical place stock can sit at one branch (e.g. "Main Store",
 * "Kitchen Walk-in", "Bar Fridge"). Always branch-scoped, same reasoning as
 * floors.ts/kitchen_stations.ts — physical storage differs per location,
 * so there's no sensible restaurant-wide default. A lookup/reference table
 * only in this task — actual stock levels per location are derived from
 * the ledger (P3-09/P3-10), not stored or assigned here.
 *
 * P3-17: `isSaleDeductionDefault` is which one location a sale's automatic
 * stock deduction pulls ingredients from for this branch — a restaurant
 * only has one working stock room/kitchen store doing double duty for
 * sales in practice, so one flag rather than a per-product/category
 * mapping (that level of control isn't asked for by this task). A branch
 * with none set simply gets no automatic deduction (SalesStockDeductionService
 * logs and skips rather than blocking the sale — rule 14), same documented-
 * gap shape as P2-06's out-of-stock push-to-terminals. The partial unique
 * index is the real guard against two defaults existing at once; the
 * service layer (StorageLocationsService.update) unsets any previous
 * default in the same branch first, same two-layer convention as P2-16's
 * table-occupancy index.
 */
export const storageLocations = pgTable(
  "storage_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isSaleDeductionDefault: boolean("is_sale_deduction_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("storage_locations_one_sale_default_per_branch_idx")
      .on(table.branchId)
      .where(sql`${table.isSaleDeductionDefault} = true`),
    pgPolicy("storage_locations_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
