import { sql } from "drizzle-orm";
import { bigint, check, index, numeric, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { inventoryItems } from "./inventory-items.js";
import { purchaseOrders } from "./purchase-orders.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { units } from "./units.js";

/**
 * P3-21: one line on a purchase order — what's ordered, how much, and at
 * what cost. `quantity`/`unitId` are in whatever unit the order was
 * placed in (e.g. a carton), not necessarily the item's own stock-keeping
 * base unit — same "this table never converts on its own" convention
 * recipe_items.ts/stock_ledger.ts already follow; P3-22's goods-received
 * flow is what reconciles the two via packages/domain's convertQuantity
 * when stock actually moves.
 *
 * `receivedQuantity` (same unit as `quantity`) starts at zero and stays
 * there — nothing in this task writes to it. It exists now because it's
 * this line's own data, not because anything here needs it yet; P3-22
 * is what actually increments it and, by comparing it against `quantity`
 * across every line, decides whether the order's own status becomes
 * partly_received or closed.
 *
 * `returnedQuantity` (P3-24) is the same idea for stock sent back to the
 * supplier after having been accepted — PurchaseReturnsService is its
 * only writer, and validates a return against `receivedQuantity -
 * returnedQuantity` (what's still actually held from this line) rather
 * than against `quantity` (what was originally ordered).
 */
export const purchaseOrderItems = pgTable(
  "purchase_order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => inventoryItems.id),
    quantity: numeric("quantity", { mode: "number", precision: 18, scale: 6 }).notNull(),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id),
    unitCostMinor: bigint("unit_cost_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    receivedQuantity: numeric("received_quantity", { mode: "number", precision: 18, scale: 6 }).notNull().default(0),
    returnedQuantity: numeric("returned_quantity", { mode: "number", precision: 18, scale: 6 }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("purchase_order_items_quantity_positive", sql`${table.quantity} > 0`),
    check("purchase_order_items_unit_cost_non_negative", sql`${table.unitCostMinor} >= 0`),
    check("purchase_order_items_received_quantity_non_negative", sql`${table.receivedQuantity} >= 0`),
    check("purchase_order_items_returned_quantity_non_negative", sql`${table.returnedQuantity} >= 0`),
    // P3-41: every caller of this table (goods receiving, supplier invoice
    // matching, purchase returns, the order's own item list) fetches "this
    // purchase order's items" by purchaseOrderId — the single hottest
    // lookup against this table, with no index behind it until now.
    index("purchase_order_items_purchase_order_idx").on(table.purchaseOrderId),
    pgPolicy("purchase_order_items_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
