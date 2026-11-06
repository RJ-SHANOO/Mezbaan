import { jsonb, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * An append-only audit log (bootstrapped by P1-13 to record manager-PIN approvals,
 * completed by P1-14: DB-level enforcement plus coverage of every sensitive action
 * built so far). "Append-only" is enforced twice, same as rule 4's financial tables:
 * AuditLogService exposes only record(), never update/delete, and app-role.ts REVOKEs
 * UPDATE/DELETE on this table from the app role at the database level.
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
