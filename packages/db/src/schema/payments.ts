import { sql } from "drizzle-orm";
import { bigint, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { invoices } from "./invoices.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { users } from "./users.js";

/**
 * P2-19: one row per tendered payment against an invoice (P2-18) — append-only
 * (rule 4 names "payments" explicitly; UPDATE/DELETE revoked in app-role.ts,
 * same enforcement as invoices/audit_logs/order_status_history). Deliberately
 * not unique-per-invoice: a single invoice can take more than one payment row
 * (cash + card, say) — P2-20 is what actually enforces that `amountMinor`
 * across every row never exceeds the invoice total (PaymentsService.record),
 * turning "allowed by the schema" into "a real split payment."
 *
 * `tipMinor` is its own column, not folded into `amountMinor` — a tip isn't
 * part of the bill (rule 6: never under- or over-report what a sale actually
 * was), so keeping it separate is what lets a future report distinguish
 * "collected for the sale" from "collected as a tip" without guessing.
 *
 * `changeMinor` (P2-20) is cash-only: how much of what the customer physically
 * handed over was handed back as change, not applied to the bill. `amountMinor`
 * is always just the part that paid down the invoice — change is never folded
 * into it, same reasoning as keeping `tipMinor` separate.
 */
export const payments = pgTable(
  "payments",
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
    method: text("method", { enum: ["cash", "card", "bank_transfer", "wallet"] }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    tipMinor: bigint("tip_minor", { mode: "bigint" }).notNull(),
    changeMinor: bigint("change_minor", { mode: "bigint" }).notNull().default(sql`0`),
    currency: text("currency").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("payments_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
