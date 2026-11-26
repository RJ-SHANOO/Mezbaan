import { sql } from "drizzle-orm";
import { bigint, check, index, numeric, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { inventoryItems } from "./inventory-items.js";
import { purchaseOrderItems } from "./purchase-order-items.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { supplierInvoices } from "./supplier-invoices.js";

/**
 * P3-23: one purchase-order line's share of a supplier invoice — what
 * the supplier is billing for, in that PO line's own unit. Compared
 * against purchase_order_items.quantity/unitCostMinor (what was ordered)
 * and purchase_order_items.receivedQuantity (what P3-22's goods received
 * notes confirm actually arrived) by SupplierInvoicesService.record —
 * see supplier-invoice-match-flags.ts for what a mismatch produces.
 */
export const supplierInvoiceItems = pgTable(
  "supplier_invoice_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    supplierInvoiceId: uuid("supplier_invoice_id")
      .notNull()
      .references(() => supplierInvoices.id),
    purchaseOrderItemId: uuid("purchase_order_item_id")
      .notNull()
      .references(() => purchaseOrderItems.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => inventoryItems.id),
    quantity: numeric("quantity", { mode: "number", precision: 18, scale: 6 }).notNull(),
    unitCostMinor: bigint("unit_cost_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("supplier_invoice_items_quantity_positive", sql`${table.quantity} > 0`),
    check("supplier_invoice_items_unit_cost_non_negative", sql`${table.unitCostMinor} >= 0`),
    // P3-41: every caller fetches "this invoice's lines" by
    // supplierInvoiceId alone — no index behind it until now.
    index("supplier_invoice_items_invoice_idx").on(table.supplierInvoiceId),
    pgPolicy("supplier_invoice_items_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
