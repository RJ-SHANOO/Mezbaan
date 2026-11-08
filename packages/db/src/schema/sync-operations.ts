import { pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { devices } from "./devices.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * Server side of P1-25's sync client: every operation a terminal's local
 * operation_log has sent and the server has durably recorded, keyed by id
 * (client-generated UUIDv7) and deduplicated per restaurant by idempotency_key —
 * a retried batch (crash, timeout after the server actually committed) upserts
 * nothing new and the client still gets back the same "accepted" result (rule 9).
 *
 * payload is stored as the same JSON-encoded string the client sent, not parsed
 * into jsonb — nothing here interprets operation_type-specific contents yet (no
 * business write exists before Phase 2), so there's nothing to gain from parsing
 * it, and every risk of a parse/round-trip mismatch to avoid by not doing so.
 */
export const syncOperations = pgTable(
  "sync_operations",
  {
    id: uuid("id").primaryKey(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id),
    idempotencyKey: text("idempotency_key").notNull(),
    operationType: text("operation_type").notNull(),
    payload: text("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sync_operations_restaurant_idempotency_idx").on(table.restaurantId, table.idempotencyKey),
    pgPolicy("sync_operations_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
