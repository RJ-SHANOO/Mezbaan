import { jsonb, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * A minimal append-only audit log (bootstrapped early by P1-13, which needs somewhere
 * to record manager-PIN approvals; the full build-out — screens, coverage of every
 * sensitive action across every module — is P1-14). "Append-only" here is enforced by
 * convention: AuditLogService exposes only record(), never update/delete. Unlike the
 * financial tables in rule 4, there's no DB-level REVOKE UPDATE/DELETE yet — add one
 * if/when P1-14 decides that's warranted platform-wide.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    // Nullable: not every audited action is scoped to one branch (e.g. restaurant-wide
    // settings changes).
    branchId: uuid("branch_id"),
    // Nullable: a system/background job can also write an audit entry with no human actor.
    actorUserId: uuid("actor_user_id"),
    deviceId: uuid("device_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("audit_logs_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
