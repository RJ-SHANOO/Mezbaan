import { pgPolicy, pgTable, integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { users } from "./users.js";
import { tenantMatch } from "./rls.js";

/**
 * A manager's PIN for approving a sensitive action (void, refund, discount, ...) in
 * place, without logging the manager into the terminal (P1-13). One PIN per user,
 * same "store only the hash" rule as users.passwordHash (rule 20) — reuses the exact
 * same scrypt helper, just a different secret.
 */
export const managerPins = pgTable(
  "manager_pins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    pinHash: text("pin_hash").notNull(),
    // Lockout is tracked per-PIN because approval always names the manager up front
    // (the cashier picks who's approving, then that person enters their PIN) — see
    // ManagerPinService.approve. A wrong guess only ever counts against the PIN it
    // was tried against, never a shared/global counter.
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("manager_pins_restaurant_user_idx").on(table.restaurantId, table.userId),
    pgPolicy("manager_pins_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
