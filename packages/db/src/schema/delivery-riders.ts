import { boolean, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P2-10: a lightweight, branch-scoped roster of delivery riders. Deliberately
 * NOT a user account/role — "Roles" (CLAUDE.md section 0) is a fixed list of
 * five (Super Admin, Owner, Branch Manager, Cashier, Kitchen Staff) and a
 * rider isn't one of them. Small restaurants commonly staff delivery with
 * informal riders who never log into anything; this is just a name/phone a
 * cashier can pick from when assigning a delivery, not an auth principal.
 */
export const deliveryRiders = pgTable(
  "delivery_riders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("delivery_riders_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
