import { index, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { purchaseOrders } from "./purchase-orders.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { storageLocations } from "./storage-locations.js";
import { users } from "./users.js";

/**
 * P3-24: stock already accepted (P3-22) being sent back to the supplier
 * it came from — a real event, so append-only (rule 4's convention,
 * UPDATE/DELETE revoked in app-role.ts) same as goods-received-notes.ts.
 * "Compensating stock movements" is this task's own wording for exactly
 * what PurchaseReturnsService.record does: one negative stock_ledger
 * "return" row per line (the same movement type P3-18's sales-side
 * refunds use for the opposite direction — see stock-ledger.ts's own
 * "signed, not type-implied direction" reasoning), never an edit to the
 * original "purchase" row that first brought the stock in.
 */
export const purchaseReturns = pgTable(
  "purchase_returns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id),
    storageLocationId: uuid("storage_location_id")
      .notNull()
      .references(() => storageLocations.id),
    returnedByUserId: uuid("returned_by_user_id")
      .notNull()
      .references(() => users.id),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // P3-41: PurchaseReturnsService reads "this order's returns" by
    // purchaseOrderId alone; the supplier purchase report (P3-33) filters
    // the same column plus a createdAt range — one composite index serves
    // both.
    index("purchase_returns_purchase_order_created_idx").on(table.purchaseOrderId, table.createdAt),
    pgPolicy("purchase_returns_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
