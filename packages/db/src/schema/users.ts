import { pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { restaurants } from "./restaurants.js";
import { roles } from "./roles.js";
import { tenantMatch } from "./rls.js";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    // NULL = access to every branch in the restaurant (e.g. an Owner); set = scoped to
    // one branch (Branch Manager, Cashier, Kitchen Staff typically work at one branch).
    branchId: uuid("branch_id").references(() => branches.id),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id),
    email: text("email").notNull(),
    // Hashing happens in the auth module (P1-11) — this column only ever stores the hash.
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status", { enum: ["active", "disabled"] })
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Email is unique per restaurant, not globally — each tenant is independent, and
    // login resolves the restaurant (by slug) before looking up the user by email.
    uniqueIndex("users_restaurant_id_email_idx").on(table.restaurantId, table.email),
    pgPolicy("users_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
