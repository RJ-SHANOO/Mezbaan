import { sql } from "drizzle-orm";
import { bigint, check, index, numeric, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { goodsReceivedNotes } from "./goods-received-notes.js";
import { inventoryItems } from "./inventory-items.js";
import { purchaseOrderItems } from "./purchase-order-items.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P3-22: one purchase-order line's share of one delivery. `deliveredQuantity`
 * is everything that physically showed up for this line, in the purchase
 * order item's own unit; `rejectedQuantity` (same unit, <= delivered) is
 * however much of that was refused on the spot. The quantity that actually
 * enters stock — "accepted" — is delivered minus rejected, computed by
 * GoodsReceivedNotesService rather than stored a third time, same
 * derive-don't-duplicate reasoning stock_levels.ts already follows for its
 * own relationship to stock_ledger.
 *
 * `invoicedUnitCostMinor` is what the supplier's own delivery note/invoice
 * actually charged for this line — independent of
 * purchase_order_items.unitCostMinor (what was ordered at), and often not
 * equal to it; that gap is this task's "price difference," always
 * re-derivable by joining back to the immutable-once-approved PO line
 * rather than stored a second time. It's also the cost
 * StockLedgerService.recordMovementInTx values the resulting stock
 * increase at — rule 3/11: the real price paid, not the quoted one.
 */
export const goodsReceivedNoteItems = pgTable(
  "goods_received_note_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    goodsReceivedNoteId: uuid("goods_received_note_id")
      .notNull()
      .references(() => goodsReceivedNotes.id),
    purchaseOrderItemId: uuid("purchase_order_item_id")
      .notNull()
      .references(() => purchaseOrderItems.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => inventoryItems.id),
    deliveredQuantity: numeric("delivered_quantity", { mode: "number", precision: 18, scale: 6 }).notNull(),
    rejectedQuantity: numeric("rejected_quantity", { mode: "number", precision: 18, scale: 6 }).notNull().default(0),
    rejectionReasonCode: text("rejection_reason_code"),
    invoicedUnitCostMinor: bigint("invoiced_unit_cost_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("goods_received_note_items_delivered_positive", sql`${table.deliveredQuantity} > 0`),
    check("goods_received_note_items_rejected_non_negative", sql`${table.rejectedQuantity} >= 0`),
    check("goods_received_note_items_rejected_not_more_than_delivered", sql`${table.rejectedQuantity} <= ${table.deliveredQuantity}`),
    check("goods_received_note_items_invoiced_cost_non_negative", sql`${table.invoicedUnitCostMinor} >= 0`),
    // P3-41: every caller fetches "this note's lines" by goodsReceivedNoteId
    // alone — no index behind it until now.
    index("goods_received_note_items_note_idx").on(table.goodsReceivedNoteId),
    pgPolicy("goods_received_note_items_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
