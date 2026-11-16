import { sql } from "drizzle-orm";
import { bigint, jsonb, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { devices } from "./devices.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { users } from "./users.js";

/**
 * P2-27: one row per cashier shift at a till (device). `openingFloatMinor`
 * is the lump starting-cash amount handed to the cashier (rule 5 — bigint
 * minor units); the denomination breakdown only matters at close, where a
 * miscount is the whole point of counting. `closingCashCounts` is a
 * one-time snapshot (jsonb array of `{ denominationMinor, count }`), same
 * pattern as invoices.appliedTaxRules — captured once, never recomputed in
 * place. `countedCashMinor` is stored alongside it (derived via
 * packages/domain at close time, never hand-summed by the caller) purely so
 * reports can read a shift's counted total without re-summing the JSON
 * every time.
 *
 * Over/short and X/Z reports are explicitly out of scope here — P2-29 adds
 * those once P2-28's cash in/out exists too; this task only lays the
 * open/close/count foundation.
 */
export const shifts = pgTable(
  "shifts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id),
    openedByUserId: uuid("opened_by_user_id")
      .notNull()
      .references(() => users.id),
    openingFloatMinor: bigint("opening_float_minor", { mode: "bigint" }).notNull(),
    openingNote: text("opening_note"),
    currency: text("currency").notNull(),
    status: text("status", { enum: ["open", "closed"] }).notNull().default("open"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedByUserId: uuid("closed_by_user_id").references(() => users.id),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    // [{ denominationMinor: string, count: number }] — captured once at close.
    closingCashCounts: jsonb("closing_cash_counts"),
    countedCashMinor: bigint("counted_cash_minor", { mode: "bigint" }),
    closingNote: text("closing_note"),
  },
  (table) => [
    // Same two-layer convention as P2-16's orders_table_occupancy_idx: the
    // service checks for an existing open shift before inserting, but this
    // partial unique index is the real guard against two concurrent opens
    // on the same till racing past that check.
    uniqueIndex("shifts_device_open_idx")
      .on(table.deviceId)
      .where(sql`${table.status} = 'open'`),
    pgPolicy("shifts_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
