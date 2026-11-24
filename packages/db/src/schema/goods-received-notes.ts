import { pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { purchaseOrders } from "./purchase-orders.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { storageLocations } from "./storage-locations.js";
import { users } from "./users.js";

/**
 * P3-22: one delivery actually received against a purchase order — unlike
 * purchase_orders.ts itself (a living document moving through its own
 * draft/approved/sent lifecycle), this documents something that already
 * physically happened, so it's append-only (rule 4's convention,
 * UPDATE/DELETE revoked in app-role.ts) same as invoices/stock_ledger. One
 * purchase order can have several of these over time — that's what makes
 * "partial delivery" real: the order's own partly_received/closed status
 * (GoodsReceivedNotesService.recordNote) is derived by comparing every
 * line's cumulative receivedQuantity against what was ordered, not by this
 * table alone.
 *
 * `storageLocationId` is a deliberate caller choice, not a per-branch
 * default the way P3-17's sale deduction uses one — receiving goods into a
 * store room is a different physical point than consuming them, so there's
 * no sensible single default to reuse here.
 */
export const goodsReceivedNotes = pgTable(
  "goods_received_notes",
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
    receivedByUserId: uuid("received_by_user_id")
      .notNull()
      .references(() => users.id),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("goods_received_notes_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
