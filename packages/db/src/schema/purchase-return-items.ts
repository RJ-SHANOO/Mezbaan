import { sql } from "drizzle-orm";
import { check, index, numeric, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { inventoryItems } from "./inventory-items.js";
import { purchaseOrderItems } from "./purchase-order-items.js";
import { purchaseReturns } from "./purchase-returns.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P3-24: one purchase-order line's share of a return — how much of what
 * was accepted from that line is going back, in the PO line's own unit.
 * `reasonCode` is required (PurchaseReturnsService validates against
 * purchase_return_reason_codes), unlike goods_received_note_items.ts
 * where it's only required when something was actually rejected — every
 * row here represents an active decision to send stock back, so there's
 * always a reason to record.
 */
export const purchaseReturnItems = pgTable(
  "purchase_return_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    purchaseReturnId: uuid("purchase_return_id")
      .notNull()
      .references(() => purchaseReturns.id),
    purchaseOrderItemId: uuid("purchase_order_item_id")
      .notNull()
      .references(() => purchaseOrderItems.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => inventoryItems.id),
    quantity: numeric("quantity", { mode: "number", precision: 18, scale: 6 }).notNull(),
    reasonCode: text("reason_code").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("purchase_return_items_quantity_positive", sql`${table.quantity} > 0`),
    // P3-41: every caller fetches "this return's lines" by
    // purchaseReturnId alone — no index behind it until now.
    index("purchase_return_items_return_idx").on(table.purchaseReturnId),
    pgPolicy("purchase_return_items_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
