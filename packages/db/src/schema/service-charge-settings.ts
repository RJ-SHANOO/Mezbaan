import { boolean, integer, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P2-05: a service-charge percentage, scoped by branch and/or order type
 * with the same nullable-means-universal convention as tax_rules/price_lists.
 * Unlike tax_rules (which stack/sum by name), a sale has exactly one
 * service-charge line, so ServiceChargeResolutionService picks the single
 * most specifically-scoped active row rather than summing — there's no
 * "name" to dedupe by since there's only one concept here, not several
 * components.
 *
 * isTaxable records whether the computed service-charge amount itself is
 * folded into the tax base, or left untaxed on top — a real per-restaurant
 * choice (some jurisdictions tax service charges, some don't), consumed by
 * TaxCalculationService.previewCharges.
 */
export const serviceChargeSettings = pgTable(
  "service_charge_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    rateBasisPoints: integer("rate_basis_points").notNull(),
    branchId: uuid("branch_id").references(() => branches.id),
    orderType: text("order_type", { enum: ["dine_in", "takeaway", "delivery"] }),
    isTaxable: boolean("is_taxable").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("service_charge_settings_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
