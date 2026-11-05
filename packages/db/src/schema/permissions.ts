import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * A global catalog of permission keys. This seeds a small representative set — the
 * full catalog grows one INSERT at a time as each module adds its own checks (P1-12
 * builds the actual enforcement logic); that's data, not a schema change.
 */
export const permissions = pgTable("permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  description: text("description").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
