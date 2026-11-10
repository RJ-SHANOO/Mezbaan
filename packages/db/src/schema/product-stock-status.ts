import { sql } from "drizzle-orm";
import { pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { productVariants } from "./product-variants.js";
import { products } from "./products.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { users } from "./users.js";

/**
 * P2-06: an "86" marking — a product or variant that has run out at one
 * branch. Same exclusion-list convention as product_branch_availability/
 * feature_flags: a row's mere existence means "currently out of stock";
 * clearing it deletes the row (ProductStockStatusService still audits both
 * the mark and the clear, same as every other mutation here — this isn't a
 * financial record, so rule 4's append-only requirement doesn't apply).
 *
 * Unlike product_branch_availability (a slow-moving admin setting), this is
 * meant to be toggled all day at the register or in the kitchen, so it's
 * gated by its own permission (pos.mark_out_of_stock) rather than
 * menu.manage. branchId is NOT nullable here, unlike price_lists/tax_rules'
 * "null means everywhere" convention: stock is a physically per-branch fact,
 * not a setting with a sensible restaurant-wide default.
 *
 * Exactly one of productId/variantId is set (enforced at the service layer,
 * same reason as price_list_items — RLS doesn't protect a bare FK check),
 * with the same two-partial-unique-index shape, scoped additionally by
 * branch so the same product can be 86'd independently at each branch.
 *
 * "Syncs quickly to all terminals and kitchen screens" (the task's own
 * wording) has no real push transport to land on yet: the branch hub's
 * WebSocket/LAN layer is P2-36 through P2-39, still unbuilt, and neither a
 * POS terminal screen (P2-11+) nor a kitchen screen (P3-03) exists to be a
 * push target. This table and its service are the real, immediately-
 * consistent source of truth — any read sees the current state the instant
 * it changes, same as every other catalog read in this codebase; wiring an
 * actual push channel on top of it is P2-36/P2-38's job once the hub exists
 * to carry it.
 */
export const productStockStatus = pgTable(
  "product_stock_status",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    productId: uuid("product_id").references(() => products.id),
    variantId: uuid("variant_id").references(() => productVariants.id),
    reason: text("reason"),
    markedByUserId: uuid("marked_by_user_id")
      .notNull()
      .references(() => users.id),
    markedAt: timestamp("marked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("product_stock_status_branch_product_idx").on(table.branchId, table.productId).where(sql`${table.variantId} IS NULL`),
    uniqueIndex("product_stock_status_branch_variant_idx").on(table.branchId, table.variantId).where(sql`${table.variantId} IS NOT NULL`),
    pgPolicy("product_stock_status_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
