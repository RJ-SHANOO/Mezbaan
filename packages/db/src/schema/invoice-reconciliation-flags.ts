import { bigint, index, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { invoices } from "./invoices.js";
import { orders } from "./orders.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P2-26 (rule 3: "the server recalculates each synced sale and flags any
 * mismatch for review... it never silently changes a recorded sale"). A row
 * here means ReconciliationService independently recomputed an invoice's
 * totals from its own order items and got a different answer than what's
 * stored — the invoice itself is never touched (it stays exactly as
 * generated, append-only per rule 4); this is purely an additive diagnostic
 * trail for someone to review.
 *
 * Not revoked from UPDATE/DELETE the way invoices/payments/refunds are —
 * this isn't a financial ledger record itself, just a pointer at one, and a
 * future "mark reviewed" action needs to update it in place.
 */
export const invoiceReconciliationFlags = pgTable(
  "invoice_reconciliation_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    storedSubtotalMinor: bigint("stored_subtotal_minor", { mode: "bigint" }).notNull(),
    expectedSubtotalMinor: bigint("expected_subtotal_minor", { mode: "bigint" }).notNull(),
    storedServiceChargeMinor: bigint("stored_service_charge_minor", { mode: "bigint" }).notNull(),
    expectedServiceChargeMinor: bigint("expected_service_charge_minor", { mode: "bigint" }).notNull(),
    storedTaxMinor: bigint("stored_tax_minor", { mode: "bigint" }).notNull(),
    expectedTaxMinor: bigint("expected_tax_minor", { mode: "bigint" }).notNull(),
    storedTotalMinor: bigint("stored_total_minor", { mode: "bigint" }).notNull(),
    expectedTotalMinor: bigint("expected_total_minor", { mode: "bigint" }).notNull(),
    // Which field(s) actually differed — "subtotal", "serviceCharge", "tax", "total", or a
    // comma-joined combination — so a reviewer doesn't have to diff eight numbers by hand.
    mismatchedFields: text("mismatched_fields").notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("invoice_reconciliation_flags_restaurant_created_idx").on(table.restaurantId, table.createdAt),
    pgPolicy("invoice_reconciliation_flags_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
