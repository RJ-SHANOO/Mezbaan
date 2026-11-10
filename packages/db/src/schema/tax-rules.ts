import { boolean, integer, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P2-05: a named tax rate component (e.g. "GST", "Sales Tax"), scoped by
 * branch and/or order type with the same nullable-means-universal convention
 * as price_lists (P2-04): branchId null = every branch, orderType null =
 * every order type.
 *
 * Multiple active rules can match the same scope and are summed by
 * TaxRuleResolutionService (compound tax, e.g. CGST + SGST) rather than one
 * "best match" winning outright — real tax regimes commonly stack more than
 * one named component on a single sale. When two active rules share the same
 * name and both match a scope (e.g. a restaurant-wide "GST" default and a
 * branch-specific "GST" override), the resolver keeps only the more
 * specifically-scoped one for that name so the override replaces the
 * default instead of adding to it.
 */
export const taxRules = pgTable(
  "tax_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    name: text("name").notNull(),
    rateBasisPoints: integer("rate_basis_points").notNull(),
    branchId: uuid("branch_id").references(() => branches.id),
    orderType: text("order_type", { enum: ["dine_in", "takeaway", "delivery"] }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("tax_rules_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
