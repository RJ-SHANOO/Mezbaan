import { bigint, index, numeric, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { purchaseOrderItems } from "./purchase-order-items.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { supplierInvoiceItems } from "./supplier-invoice-items.js";
import { supplierInvoices } from "./supplier-invoices.js";
import { users } from "./users.js";

/**
 * P3-23: one row per supplier_invoice_item whose three-way match (order,
 * receipt, invoice) found a problem — same reasoning as
 * invoice_reconciliation_flags.ts (P2-26): the invoice itself is never
 * touched, this is purely an additive diagnostic trail. Not revoked from
 * UPDATE/DELETE the way supplier_invoices itself is — this isn't the
 * external document, just a pointer at a line of it, and "mark reviewed"
 * needs to update it in place.
 *
 * `mismatchedFields` is a comma-joined combination of which checks
 * failed: "quantity_exceeds_ordered" (billed for more than was ever
 * ordered), "quantity_exceeds_received" (billed for more than
 * purchase_order_items.receivedQuantity confirms actually arrived), and/or
 * "price" (the invoice's own unitCostMinor doesn't match what the PO line
 * was ordered at) — a reviewer reads this instead of diffing the stored
 * numbers by hand, same convention as invoice_reconciliation_flags' own
 * column.
 */
export const supplierInvoiceMatchFlags = pgTable(
  "supplier_invoice_match_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    supplierInvoiceId: uuid("supplier_invoice_id")
      .notNull()
      .references(() => supplierInvoices.id),
    supplierInvoiceItemId: uuid("supplier_invoice_item_id")
      .notNull()
      .references(() => supplierInvoiceItems.id),
    purchaseOrderItemId: uuid("purchase_order_item_id")
      .notNull()
      .references(() => purchaseOrderItems.id),
    invoicedQuantity: numeric("invoiced_quantity", { mode: "number", precision: 18, scale: 6 }).notNull(),
    orderedQuantity: numeric("ordered_quantity", { mode: "number", precision: 18, scale: 6 }).notNull(),
    receivedQuantity: numeric("received_quantity", { mode: "number", precision: 18, scale: 6 }).notNull(),
    invoicedUnitCostMinor: bigint("invoiced_unit_cost_minor", { mode: "bigint" }).notNull(),
    orderedUnitCostMinor: bigint("ordered_unit_cost_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    mismatchedFields: text("mismatched_fields").notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("supplier_invoice_match_flags_restaurant_created_idx").on(table.restaurantId, table.createdAt),
    pgPolicy("supplier_invoice_match_flags_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
