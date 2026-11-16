import { bigint, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { creditCustomers } from "./credit-customers.js";
import { invoices } from "./invoices.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { users } from "./users.js";

/**
 * P2-25: the credit customer's account ledger — append-only (rule 4's
 * "never update or delete" convention, same enforcement as invoices/
 * payments/refunds; UPDATE/DELETE revoked in app-role.ts). `amountMinor` is
 * always a positive magnitude; whether it increases or decreases the
 * balance owed comes from `entryType` alone, never the sign — a "charge"
 * increases what the customer owes, a "repayment" decreases it.
 * `invoiceId` is set only for a charge tied to a specific sale (optional:
 * CreditCustomersService.recordRepayment never sets it) — purely for
 * audit/context, not used to compute anything.
 */
export const creditLedgerEntries = pgTable(
  "credit_ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    creditCustomerId: uuid("credit_customer_id")
      .notNull()
      .references(() => creditCustomers.id),
    entryType: text("entry_type", { enum: ["charge", "repayment"] }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    note: text("note"),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("credit_ledger_entries_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
