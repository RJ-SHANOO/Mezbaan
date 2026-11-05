import { pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
    // NULL until paired (P1-20 issues the token and sets this). Never store the raw
    // token — only its hash, same as passwordHash on users (rule 20).
    tokenHash: text("token_hash"),
    status: text("status", { enum: ["active", "revoked"] })
      .notNull()
      .default("active"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("devices_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
