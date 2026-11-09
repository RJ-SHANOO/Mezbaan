import { sql } from "drizzle-orm";
import { index, integer, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    label: text("label").notNull(),
    deviceType: text("device_type", {
      enum: ["pos_terminal", "kitchen_display", "tablet", "other"],
    }).notNull(),
    // Sequential per branch (1, 2, 3, ...), assigned once at creation — the "T2"
    // half of a P1-28 document number. Never reused, even if the device is revoked.
    // DEFAULT NULL only exists so Drizzle treats this as optional at insert time —
    // a DB trigger (see the migration) always assigns the real value before the
    // NOT NULL check runs, whether or not a caller passes one explicitly.
    terminalNumber: integer("terminal_number").notNull().default(sql`NULL`),
    // NULL until paired (P1-20 issues the token and sets this). Never store the raw
    // token — only its hash, same as passwordHash on users (rule 20).
    tokenHash: text("token_hash"),
    // Set when an admin generates a one-time pairing code (P1-20); cleared the moment
    // it's redeemed. Same opaque-token/hash-only pattern as tokenHash — the raw code
    // is never persisted, and it's short-lived (see DeviceService's pairing code TTL).
    pairingCodeHash: text("pairing_code_hash"),
    pairingCodeExpiresAt: timestamp("pairing_code_expires_at", { withTimezone: true }),
    status: text("status", { enum: ["active", "revoked"] })
      .notNull()
      .default("active"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("devices_branch_terminal_number_idx").on(table.branchId, table.terminalNumber),
    // P1-33: validateDeviceToken() (device.service.ts) runs this lookup on every
    // single device-authenticated request — without an index it's a full table
    // scan per request, which is exactly the kind of regression the query-plan
    // checks in query-plan.test.ts are meant to catch before it reaches production.
    index("devices_token_hash_idx").on(table.tokenHash),
    index("devices_pairing_code_hash_idx").on(table.pairingCodeHash),
    pgPolicy("devices_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
