import { sql } from "drizzle-orm";
import { check, numeric, pgPolicy, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { inventoryItems } from "./inventory-items.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { stockCounts } from "./stock-counts.js";
import { users } from "./users.js";

/**
 * P3-26: one item's blind count line. `expectedQuantity` is snapshotted
 * from stock_levels.quantity the moment the count starts (0 if the item
 * has no stock_levels row there yet) — frozen so a count isn't thrown off
 * by ordinary sales/movements happening at the same location while the
 * physical count is still in progress. `countedQuantity` is null until
 * the counter submits it (StockCountsService.submitLineCount) and, unlike
 * `expectedQuantity`, can never be negative — a physical count is always
 * zero or more, even though the system's own expected figure can be
 * negative (rule 12: offline stock may go negative).
 *
 * The variance (counted minus expected) is deliberately not stored here —
 * both halves already are, so it's always re-derivable, same
 * derive-don't-duplicate reasoning stock_levels.ts follows for its
 * relationship to stock_ledger.
 */
export const stockCountItems = pgTable(
  "stock_count_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    stockCountId: uuid("stock_count_id")
      .notNull()
      .references(() => stockCounts.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => inventoryItems.id),
    expectedQuantity: numeric("expected_quantity", { mode: "number", precision: 18, scale: 6 }).notNull(),
    countedQuantity: numeric("counted_quantity", { mode: "number", precision: 18, scale: 6 }),
    countedAt: timestamp("counted_at", { withTimezone: true }),
    countedByUserId: uuid("counted_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("stock_count_items_counted_quantity_non_negative", sql`${table.countedQuantity} IS NULL OR ${table.countedQuantity} >= 0`),
    uniqueIndex("stock_count_items_count_item_idx").on(table.stockCountId, table.itemId),
    pgPolicy("stock_count_items_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
