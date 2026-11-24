import { pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P3-20: a vendor a restaurant buys stock from. Restaurant-scoped, not
 * branch-scoped — same reasoning as units.ts/inventory_categories.ts: who
 * a restaurant's suppliers are doesn't vary by branch, even though which
 * branch actually places an order (P3-21) does. `status` is the same
 * active/inactive soft-disable convention as categories.ts/inventory-
 * categories.ts rather than a hard delete — a supplier with purchase
 * history (P3-21+) can't simply disappear.
 */
export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    name: text("name").notNull(),
    contactName: text("contact_name"),
    phone: text("phone"),
    email: text("email"),
    address: text("address"),
    status: text("status", { enum: ["active", "inactive"] })
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("suppliers_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
