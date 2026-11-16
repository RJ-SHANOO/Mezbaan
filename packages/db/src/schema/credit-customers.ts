import { sql } from "drizzle-orm";
import { bigint, boolean, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P2-25: a customer the restaurant lets buy on credit (a running account,
 * e.g. a corporate client), restaurant-scoped rather than per-branch — the
 * same customer can run one account across every branch. Deliberately not
 * the general customer-profile/loyalty concept (that's P4-04); this exists
 * only to carry a credit limit and back the ledger below.
 */
export const creditCustomers = pgTable(
  "credit_customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    name: text("name").notNull(),
    phone: text("phone"),
    creditLimitMinor: bigint("credit_limit_minor", { mode: "bigint" }).notNull().default(sql`0`),
    currency: text("currency").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("credit_customers_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
