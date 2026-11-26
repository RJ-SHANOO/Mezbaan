import { boolean, jsonb, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * An append-only audit log (bootstrapped by P1-13 to record manager-PIN approvals,
 * completed by P1-14: DB-level enforcement plus coverage of every sensitive action
 * built so far). "Append-only" is enforced twice, same as rule 4's financial tables:
 * AuditLogService exposes only record(), never update/delete, and app-role.ts REVOKEs
 * UPDATE/DELETE on this table from the app role at the database level.
 *
 * P3-40: `actingAsSuperAdmin` is stamped automatically by AuditLogService.record
 * itself (read from the current request's own tenant context), not something any
 * individual call site passes — that's what makes this "full" rather than
 * "logged wherever someone remembered to flag it": every entry this table has
 * ever recorded, going forward, is unambiguously marked as platform-ops acting
 * on a restaurant's data or not, with no call site able to get it wrong or
 * forget it. Defaults to false for a system/background job (no request, no
 * tenant context to read).
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
    actingAsSuperAdmin: boolean("acting_as_super_admin").notNull().default(false),
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
