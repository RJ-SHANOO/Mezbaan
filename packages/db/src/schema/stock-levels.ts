import { bigint, numeric, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { inventoryItems } from "./inventory-items.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { storageLocations } from "./storage-locations.js";

/**
 * P3-10: the current stock level for one item at one storage location —
 * a derived cache of stock_ledger, not a second source of truth. Unlike
 * credit_ledger_entries' balance (CreditCustomersService.computeBalance,
 * recomputed live from one customer's own bounded ledger slice on every
 * read), a branch's stock levels need to be read fast and often — menu
 * availability checks, a dashboard listing every item at every location —
 * against a ledger that only ever grows across the restaurant's entire
 * lifetime. Recomputing a live SUM over that whole history on every read
 * doesn't scale the way a single customer's own ledger does, so this
 * table exists purely as a materialized, incrementally-maintained cache:
 * StockLedgerService.recordMovement/recordTransfer upsert it in the same
 * transaction as the ledger insert that caused it.
 *
 * Because it's a cache, not the record itself, it's never append-only
 * (rule 4 doesn't apply here) — StockLevelsService.rebuild can freely
 * overwrite it by recomputing fresh from stock_ledger, which is what
 * actually backs this task's "a rebuild tool to verify them."
 *
 * P3-11: `averageCostMinor`/`currency` are this item's running weighted-
 * average unit cost at this exact location — the live number
 * blendWeightedAverageCost (packages/domain) folds a new costed delivery
 * into, and what a decrease gets valued at without changing. Null until
 * the first-ever costed movement for this (location, item) pair arrives.
 */
export const stockLevels = pgTable(
  "stock_levels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    storageLocationId: uuid("storage_location_id")
      .notNull()
      .references(() => storageLocations.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => inventoryItems.id),
    quantity: numeric("quantity", { mode: "number", precision: 18, scale: 6 }).notNull().default(0),
    averageCostMinor: bigint("average_cost_minor", { mode: "bigint" }),
    currency: text("currency"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("stock_levels_location_item_idx").on(table.storageLocationId, table.itemId),
    pgPolicy("stock_levels_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
