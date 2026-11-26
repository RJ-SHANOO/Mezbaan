import { bigint, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { commissionRuns } from "./commission-runs.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P3-38: the restaurant-facing document for one already-computed
 * commission_runs row — a 1:1 snapshot (one statement per run, enforced by
 * the unique index on commissionRunId), created by CommissionRunService in
 * the same transaction as the run itself (P3-37's own run is the internal
 * computation; this is what the restaurant actually sees). Append-only,
 * same rule-4 enforcement as commission_runs/commission_entries —
 * UPDATE/DELETE revoked in app-role.ts.
 *
 * `totalAmountMinor`/`currency`/the period are copied straight from the
 * run rather than joined on read, the same "snapshot at creation" choice
 * every other append-only table in this codebase makes. There's no status
 * column (issued/paid/etc.) — same reasoning as invoices.ts never having
 * one: "how much is still owed" is always derived by summing
 * settlement_payments against totalAmountMinor (SettlementStatementsService
 * .getBalance), the exact PaymentsService.getBalance pattern from P2-20,
 * just for the opposite direction of money (restaurant paying the
 * platform, not a customer paying the restaurant).
 *
 * Written by the worker process under that restaurant's own tenant
 * context (restaurantId set, not super-admin) — the same way
 * CommissionRunService already writes commission_runs — so the RLS policy
 * here is one unified tenantMatch, not an insert/select split; there's no
 * controller endpoint that lets a restaurant (or anyone) write one
 * directly, so app-level control is what actually restricts writes, the
 * same reasoning commission-runs.ts's own policy already uses.
 */
export const settlementStatements = pgTable(
  "settlement_statements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    commissionRunId: uuid("commission_run_id")
      .notNull()
      .references(() => commissionRuns.id),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    totalAmountMinor: bigint("total_amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("settlement_statements_commission_run_idx").on(table.commissionRunId),
    pgPolicy("settlement_statements_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
