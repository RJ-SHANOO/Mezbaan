import { index, integer, jsonb, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P1-30: the transactional outbox (section 5 — "the outbox row is written in the
 * same transaction as the business change"). There's no real producer yet (every
 * actual business write is Phase 2+), so this is the generic table and worker
 * only, same situation operation_log (P1-24) and sync_operations (P1-26) were in
 * before their real callers existed.
 *
 * Not append-only like the financial tables in rule 4 — status/attempts/
 * last_error/processed_at are mutated in place as the worker claims and finishes
 * a row, which is normal outbox bookkeeping, not a financial record.
 */
export const outbox = pgTable(
  "outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status", { enum: ["pending", "processing", "processed", "dead_letter"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    // When this row next becomes eligible for a claim — set to now() on insert,
    // pushed forward with backoff on a failed attempt (rule 15).
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("outbox_status_available_at_idx").on(table.status, table.availableAt),
    pgPolicy("outbox_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
