import { bigint, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { shifts } from "./shifts.js";
import { users } from "./users.js";

/**
 * P2-28: a manual cash movement (in or out) against an open shift's drawer
 * — append-only, same rule-4 enforcement as invoices/payments/refunds/
 * credit_ledger_entries (UPDATE/DELETE revoked in app-role.ts).
 * `amountMinor` is always a positive magnitude; `direction` alone decides
 * whether it added to or removed from the drawer. Deliberately carries no
 * balance check against expected drawer cash — that reconciliation (over/
 * short) is P2-29's job, once P2-27's opening float and this ledger both
 * exist to reconcile against.
 */
export const cashMovements = pgTable(
  "cash_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    shiftId: uuid("shift_id")
      .notNull()
      .references(() => shifts.id),
    direction: text("direction", { enum: ["in", "out"] }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    reasonCode: text("reason_code").notNull(),
    note: text("note"),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("cash_movements_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
