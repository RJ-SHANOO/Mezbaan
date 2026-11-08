import { sql } from "drizzle-orm";
import { integer, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

export const branches = pgTable(
  "branches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    name: text("name").notNull(),
    timezone: text("timezone").notNull(),
    status: text("status", { enum: ["active", "inactive"] })
      .notNull()
      .default("active"),
    // Sequential per restaurant (1, 2, 3, ...), assigned once at creation and never
    // reused — the "B1" half of a P1-28 document number like "B1-T2-000123". Never
    // reassigned on rename/status change; a closed branch keeps its number.
    // DEFAULT NULL only exists so Drizzle treats this as optional at insert time —
    // a DB trigger (see the migration) always assigns the real value before the
    // NOT NULL check runs, whether or not a caller passes one explicitly.
    branchNumber: integer("branch_number").notNull().default(sql`NULL`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("branches_restaurant_branch_number_idx").on(table.restaurantId, table.branchNumber),
    pgPolicy("branches_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
