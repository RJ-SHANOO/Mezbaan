import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * A global reference table, not a tenant table — the five roles (CLAUDE.md section 1)
 * are fixed across the whole platform, not something a restaurant customizes. No RLS:
 * rule 2 only requires it for tenant tables.
 */
export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key", {
    enum: ["super_admin", "owner", "branch_manager", "cashier", "kitchen_staff"],
  })
    .notNull()
    .unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
