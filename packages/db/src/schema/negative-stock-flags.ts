import { index, numeric, pgPolicy, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { inventoryItems } from "./inventory-items.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { stockLedger } from "./stock-ledger.js";
import { storageLocations } from "./storage-locations.js";
import { users } from "./users.js";

/**
 * P3-12 (rule 12: "Offline stock may go negative. Record and flag it, and
 * never block a sale because of it."). A row here means one specific
 * stock_ledger movement (`stockLedgerId`) drove a (location, item) pair's
 * stock_levels.quantity below zero — StockLedgerService checks this right
 * after every recordMovement/recordTransfer, never blocking the movement
 * itself (rule 12/14), only flagging it after the fact. The movement type
 * that actually caused it (sale, wastage, adjustment, ...) is whatever
 * `stockLedgerId` points at — this table doesn't duplicate that, same
 * "pointer at the real record, not a copy of it" reasoning as
 * invoice_reconciliation_flags.
 *
 * Built generically across every movement type rather than sale-specific,
 * even though this task's own name calls out offline sales: no code path
 * yet turns a synced offline sale into a stock_ledger "sale" movement at
 * all (that's P3-17's job) — once it exists, its movements flow through
 * this exact same mechanism with no change needed here.
 *
 * Not revoked from UPDATE/DELETE the way invoices/payments/refunds are —
 * this isn't a financial ledger record itself, just a pointer at one, and
 * the review screen's "mark reviewed" action needs to update it in place
 * (same reasoning as invoice_reconciliation_flags, which left the same
 * door open but never built the action — this task does).
 */
export const negativeStockFlags = pgTable(
  "negative_stock_flags",
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
    stockLedgerId: uuid("stock_ledger_id")
      .notNull()
      .references(() => stockLedger.id),
    quantityAfter: numeric("quantity_after", { mode: "number", precision: 18, scale: 6 }).notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("negative_stock_flags_restaurant_created_idx").on(table.restaurantId, table.createdAt),
    pgPolicy("negative_stock_flags_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
