import { numeric, pgPolicy, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { inventoryItems } from "./inventory-items.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { units } from "./units.js";

/**
 * P3-08: how one alternate unit converts to an item's own base/store unit
 * (inventory_items.baseUnitId) — e.g. "1 carton = 30 piece" when a box of
 * eggs' base unit is "piece," or "1 lb = 453.592 g" when a sack of flour's
 * base unit is "g." Deliberately a star shape centered on each item's own
 * base unit, not full pairwise from/to conversions — converting between
 * any two of an item's units always goes through its base unit
 * (quantityInUnitB = quantityInBaseUnit / factorToBaseUnit[unitB]), which
 * needs one row per alternate unit instead of one per pair. The base unit
 * itself needs no row here — its own factor is always 1 by definition.
 *
 * `factorToBaseUnit` is a real-number ratio, not money — rule 5's integer-
 * minor-units requirement is about money specifically, not physical
 * quantity, so a plain numeric column (not bigint cents-style) is the
 * right fit here.
 */
export const inventoryItemUnitConversions = pgTable(
  "inventory_item_unit_conversions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => inventoryItems.id),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id),
    factorToBaseUnit: numeric("factor_to_base_unit", { mode: "number", precision: 18, scale: 6 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("inventory_item_unit_conversions_item_unit_idx").on(table.itemId, table.unitId),
    pgPolicy("inventory_item_unit_conversions_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
