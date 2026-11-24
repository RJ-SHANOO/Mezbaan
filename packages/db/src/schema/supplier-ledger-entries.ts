import { bigint, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { supplierInvoices } from "./supplier-invoices.js";
import { suppliers } from "./suppliers.js";
import { users } from "./users.js";

/**
 * P3-25: the accounts-payable mirror of credit-ledger-entries.ts (P2-25) —
 * same append-only convention (rule 4, UPDATE/DELETE revoked in
 * app-role.ts) and same magnitude-plus-type shape: `amountMinor` is always
 * a positive number, direction comes from `entryType` alone. An "invoice"
 * entry increases what the restaurant owes this supplier (written by
 * SupplierInvoicesService.record, in the same transaction as the invoice
 * itself — every recorded supplier invoice is a real payable, not an
 * optional choice the way a customer credit sale is); a "payment" entry
 * decreases it. There's no separate "supplier payments" table, same
 * reasoning as credit-ledger-entries.ts having no separate "repayments"
 * table — a payment is nothing more than this one ledger row.
 *
 * `supplierInvoiceId` is set only for an "invoice" entry (null for a
 * payment) — a payment settles the supplier's overall running balance,
 * not one specific invoice, same "independent of which invoice" reasoning
 * CreditCustomersService.recordRepayment already follows.
 */
export const supplierLedgerEntries = pgTable(
  "supplier_ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    entryType: text("entry_type", { enum: ["invoice", "payment"] }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    supplierInvoiceId: uuid("supplier_invoice_id").references(() => supplierInvoices.id),
    note: text("note"),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("supplier_ledger_entries_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
