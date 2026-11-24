import { bigint, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { inventoryItems } from "./inventory-items.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { suppliers } from "./suppliers.js";
import { units } from "./units.js";
import { users } from "./users.js";

/**
 * P3-20: price history — append-only (rule 4's convention, UPDATE/DELETE
 * revoked in app-role.ts, same enforcement as stock_ledger) because a
 * supplier's quoted price for an item is a fact about a point in time,
 * not a mutable attribute; a new price is a new row, never an edit to an
 * old one. The "current" price for a (supplier, item) pair is simply its
 * most recent row by `createdAt` — no separate "is this the active price"
 * flag, same derivation-over-storage reasoning as stock_levels.ts being a
 * cache of stock_ledger rather than its own source of truth.
 *
 * `unitId` is the unit this price is quoted *per* (e.g. per carton, per
 * kg) — a supplier's invoice unit and this restaurant's own stock-keeping
 * base unit (inventory_items.ts) aren't necessarily the same, so this
 * doesn't assume one; P3-21's goods-received flow is what actually
 * reconciles the two via packages/domain's convertQuantity, same as every
 * other place this project converts between a recipe/purchase unit and an
 * item's base unit.
 */
export const supplierItemPrices = pgTable(
  "supplier_item_prices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => inventoryItems.id),
    unitPriceMinor: bigint("unit_price_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id),
    note: text("note"),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("supplier_item_prices_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
