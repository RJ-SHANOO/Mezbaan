import { bigint, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { isSuperAdmin, tenantMatch } from "./rls.js";
import { settlementStatements } from "./settlement-statements.js";

/**
 * P3-38: one payment the restaurant actually made to the platform against
 * a settlement statement — the reverse direction of money from
 * payments.ts (a customer paying the restaurant). Append-only (rule 4;
 * UPDATE/DELETE revoked in app-role.ts), and deliberately not
 * unique-per-statement, same reasoning as payments.ts: a restaurant can
 * settle a statement across more than one real-world transfer.
 *
 * Unlike settlement_statements (written by the worker under the
 * restaurant's own tenant context), this is always recorded by platform
 * ops after actually receiving the money (a bank transfer, typically) —
 * there is a real controller endpoint for it, gated to a super-admin
 * session the same way billing-plan-settings.ts's writes are, so the
 * select/insert split mirrors feature-flags.ts exactly: any member of the
 * restaurant can see their own payment history (transparency), but only a
 * super-admin session can record one.
 */
export const settlementPayments = pgTable(
  "settlement_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    settlementStatementId: uuid("settlement_statement_id")
      .notNull()
      .references(() => settlementStatements.id),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    // Free-text reference for whatever the real-world transfer was (bank
    // reference number, cheque number, etc.) — there's no payment-method
    // enum here the way POS payments.ts has one, since every settlement
    // payment happens outside this system entirely.
    reference: text("reference"),
    // No FK to users: the expected actor is a super-admin session, same
    // reasoning as feature_flags.updatedByUserId.
    recordedByUserId: uuid("recorded_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("settlement_payments_select", {
      for: "select",
      using: tenantMatch,
    }),
    pgPolicy("settlement_payments_insert", {
      for: "insert",
      withCheck: isSuperAdmin,
    }),
  ],
).enableRLS();
