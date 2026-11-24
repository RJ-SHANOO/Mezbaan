import { bigint, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { purchaseOrders } from "./purchase-orders.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { suppliers } from "./suppliers.js";
import { users } from "./users.js";

/**
 * P3-23: what a supplier actually bills the restaurant for, against one
 * purchase order — a real external document, not a draft the restaurant
 * edits, so it's append-only (rule 4's convention, UPDATE/DELETE revoked
 * in app-role.ts) same as invoices.ts/goods-received-notes.ts. Recording
 * one is what triggers three-way matching
 * (SupplierInvoicesService.record) against this same order's own lines
 * and their cumulative receivedQuantity (P3-22's own primitive).
 *
 * `supplierInvoiceNumber` is the supplier's own reference (printed on
 * their invoice), not a number this system generates — the unique index
 * on (restaurantId, supplierId, supplierInvoiceNumber) is the real guard
 * against accidentally recording the same physical invoice twice.
 * `totalMinor` is the supplier's own stated total, recorded verbatim
 * (rule 3/4 spirit: never silently recomputed in place) — whether it
 * actually reconciles against the sum of this invoice's own lines is
 * exactly the kind of thing three-way matching surfaces, not something
 * this table enforces.
 */
export const supplierInvoices = pgTable(
  "supplier_invoices",
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
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    supplierInvoiceNumber: text("supplier_invoice_number").notNull(),
    currency: text("currency").notNull(),
    totalMinor: bigint("total_minor", { mode: "bigint" }).notNull(),
    recordedByUserId: uuid("recorded_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("supplier_invoices_supplier_number_idx").on(table.restaurantId, table.supplierId, table.supplierInvoiceNumber),
    pgPolicy("supplier_invoices_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
