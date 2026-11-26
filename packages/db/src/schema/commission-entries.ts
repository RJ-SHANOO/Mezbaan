import { bigint, integer, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { branches } from "./branches.js";
import { invoices } from "./invoices.js";
import { payments } from "./payments.js";
import { refunds } from "./refunds.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P3-34: platform revenue — one row per payment actually collected (not
 * per invoice; a payment not yet made earns the platform nothing yet,
 * and a split payment's several rows each earn their own share as
 * they're each collected). Append-only (rule 4 names "commission
 * entries" explicitly; UPDATE/DELETE revoked in app-role.ts).
 *
 * `rateBasisPoints` is a snapshot of restaurants.commissionRateBasisPoints
 * at the moment this entry was created, not a value looked up fresh
 * whenever this row is read later (rule 7: "the rate is locked at
 * registration... later rate changes never alter past entries"). That
 * column is already permanently locked at the database level
 * (app-role.ts's own column-level GRANT excludes it from mezbaan_app's
 * UPDATE privilege entirely) — this snapshot exists anyway because rule
 * 7 is about correctness, not just today's lack of a rate-change code
 * path; if one is ever added (Super Admin tooling, P3-39), every entry
 * already recorded stays exactly as it was computed.
 *
 * Computed on `payments.amountMinor` only, never `tipMinor` — a tip
 * isn't the restaurant's sale revenue to share a cut of.
 *
 * P3-35: a refund gives some of that payment back, so the platform's own
 * cut of it has to be given back too — as a second, compensating row
 * (rule 4 again: this table is append-only, so a reversal is a new row,
 * never an edit to the original charge). `entryType` plus a *signed*
 * `amountMinor` is the same convention stock_ledger's `quantityDelta`
 * already uses: a charge is always positive, a reversal is always
 * negative, and summing the column directly gives net platform revenue
 * with no CASE expression needed anywhere that reads this table.
 * `paymentId` (which entry this reverses) and `refundId` (which refund
 * caused it) are each only ever set on the entry type they belong to —
 * a charge always has a paymentId and never a refundId, a reversal always
 * has a refundId and never a paymentId — enforced by two partial unique
 * indexes rather than two separate tables, so both kinds of entry still
 * share one ledger. The reversal amount is computed from the refund's own
 * amountMinor at the *same* rateBasisPoints as the original charge, not by
 * looking the original entry back up — correct today because rule 7 means
 * every charge for one restaurant already shares the same rate, and it
 * stays correct even if that ever changes, since the snapshot is taken
 * fresh at reversal time just like it is at charge time.
 */
export const commissionEntries = pgTable(
  "commission_entries",
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
    entryType: text("entry_type", { enum: ["charge", "reversal"] }).notNull().default("charge"),
    paymentId: uuid("payment_id").references(() => payments.id),
    refundId: uuid("refund_id").references(() => refunds.id),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    rateBasisPoints: integer("rate_basis_points").notNull(),
    currency: text("currency").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("commission_entries_payment_idx").on(table.paymentId).where(sql`${table.paymentId} IS NOT NULL`),
    uniqueIndex("commission_entries_refund_idx").on(table.refundId).where(sql`${table.refundId} IS NOT NULL`),
    pgPolicy("commission_entries_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
