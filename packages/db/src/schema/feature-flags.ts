import { boolean, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { isSuperAdmin, tenantMatch } from "./rls.js";

/**
 * A remote kill switch per restaurant per module (P1-23, section 5's "a feature flag
 * can turn off the problem module"), not a restaurant self-service setting: any
 * authenticated member of a restaurant can read their own flags (so the desktop app
 * can eventually check one before rendering a module), but only a super-admin session
 * can write one, for any restaurant — this is an incident-response tool operated by
 * platform ops, the same split restaurants.ts uses for delete.
 *
 * Absence of a row for a given moduleKey means "enabled" — callers only need to write
 * a row to turn something off, not to pre-populate every module as enabled.
 */
export const featureFlags = pgTable(
  "feature_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    moduleKey: text("module_key").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    // No FK to users: the expected actor is a super-admin session, which (like
    // audit_logs.actorUserId) isn't necessarily a row in the tenant-scoped users table.
    updatedByUserId: uuid("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("feature_flags_restaurant_module_idx").on(table.restaurantId, table.moduleKey),
    pgPolicy("feature_flags_select", {
      for: "select",
      using: tenantMatch,
    }),
    pgPolicy("feature_flags_insert", {
      for: "insert",
      withCheck: isSuperAdmin,
    }),
    pgPolicy("feature_flags_update", {
      for: "update",
      using: isSuperAdmin,
      withCheck: isSuperAdmin,
    }),
    pgPolicy("feature_flags_delete", {
      for: "delete",
      using: isSuperAdmin,
    }),
  ],
).enableRLS();
