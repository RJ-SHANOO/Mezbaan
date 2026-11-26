import { sql } from "drizzle-orm";
import { check, numeric, pgPolicy, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { inventoryItems } from "./inventory-items.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { storageLocations } from "./storage-locations.js";
import { users } from "./users.js";

/**
 * P3-29: how much of an item a branch's own storage location wants to
 * keep on hand — per (storageLocationId, itemId), not restaurant-wide,
 * since a central store and a small branch kitchen reasonably want
 * different thresholds for the same ingredient. `minQuantity` is the
 * reorder trigger (at or below this, LowStockService.listLowStock flags
 * it); `parQuantity` is the target level to restock back up to — always
 * >= minQuantity (a CHECK constraint, not just a convention: par below
 * min would make the threshold meaningless). Only a configured pair ever
 * produces an alert — an item/location with no row here is simply never
 * considered "low," the same conservative-by-omission shape as
 * discount_limit_settings.ts, just inverted (absence here means "never
 * alert" instead of "always needs approval").
 *
 * Deliberately doesn't compute or store a reorder suggestion
 * (parQuantity - current quantity) — that's P4-14's own, later task
 * ("reorder suggestions from par levels and sales history"), which needs
 * sales history this table has nothing to do with. This task only
 * surfaces the current fact: is this item low right now.
 */
export const itemParLevels = pgTable(
  "item_par_levels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    storageLocationId: uuid("storage_location_id")
      .notNull()
      .references(() => storageLocations.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => inventoryItems.id),
    minQuantity: numeric("min_quantity", { mode: "number", precision: 18, scale: 6 }).notNull(),
    parQuantity: numeric("par_quantity", { mode: "number", precision: 18, scale: 6 }).notNull(),
    updatedByUserId: uuid("updated_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("item_par_levels_min_non_negative", sql`${table.minQuantity} >= 0`),
    check("item_par_levels_par_at_least_min", sql`${table.parQuantity} >= ${table.minQuantity}`),
    uniqueIndex("item_par_levels_location_item_idx").on(table.storageLocationId, table.itemId),
    pgPolicy("item_par_levels_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
