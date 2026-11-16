import { bigint, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { invoices } from "./invoices.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { users } from "./users.js";

/**
 * P2-24: a refund is a compensating row against an invoice (P2-18), never an
 * update or deletion of the original invoice/payment rows (rule 4 — append-
 * only; UPDATE/DELETE revoked in app-role.ts, same enforcement as invoices/
 * payments). `approvedByUserId` is NOT NULL — unlike discounts (P2-22, an
 * own-authority limit) or voids (P2-23, only above firedAt), a refund always
 * needs manager approval: it reverses money already recorded as collected,
 * which rule 6 treats as the most sensitive kind of change a sale can
 * undergo. RefundsService.issue is what enforces that; the schema just
 * reflects it by making the column mandatory.
 */
export const refunds = pgTable(
  "refunds",
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
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    reasonCode: text("reason_code").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    approvedByUserId: uuid("approved_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("refunds_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
