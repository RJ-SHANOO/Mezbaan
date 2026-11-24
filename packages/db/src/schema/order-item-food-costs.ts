import { bigint, integer, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { invoices } from "./invoices.js";
import { orderItems } from "./order-items.js";
import { recipes } from "./recipes.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P3-19: one row per sold order item, written the same moment
 * SalesStockDeductionService (P3-17) deducts its ingredients — a
 * snapshot, not a live/derivable value, because recipes.ts's own
 * `version` and every ingredient's weighted-average cost
 * (stock_levels.averageCostMinor) both keep moving after the sale;
 * without this row, "what did this exact sale theoretically cost" would
 * become unanswerable the moment either one changed.
 *
 * `recipeId`/`recipeVersion` name the item's own *base* recipe only (by
 * productId or variantId, whichever the order item carries) — a
 * deliberate scope choice, not an oversight: an item's selected
 * modifiers can each carry their own recipe too (P3-14), and `costMinor`
 * already folds every one of their costs into the one total this row
 * reports, but attributing a single version number across however many
 * distinct modifier recipes also contributed has no one sensible value,
 * so this row doesn't try. Both nullable together: an item with no base
 * recipe configured at all (inventory tracking is opt-in) still gets a
 * row with nulls here, `costMinor` null too, rather than no row — a
 * report scanning "every sold item's food cost" shouldn't have to treat
 * "never looked at" and "looked at, nothing to cost" as the same gap.
 *
 * Append-only like every other financial-adjacent record in this project
 * (rule 4's convention, UPDATE/DELETE revoked in app-role.ts) — written
 * exactly once per order item, inside the same transaction
 * SalesStockDeductionService's idempotency check already guards, so
 * there's never a reason to touch a row here again.
 */
export const orderItemFoodCosts = pgTable(
  "order_item_food_costs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    recipeId: uuid("recipe_id").references(() => recipes.id),
    recipeVersion: integer("recipe_version"),
    costMinor: bigint("cost_minor", { mode: "bigint" }),
    currency: text("currency"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("order_item_food_costs_order_item_idx").on(table.orderItemId),
    pgPolicy("order_item_food_costs_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
