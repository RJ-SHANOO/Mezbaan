import { pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { inventoryItems } from "./inventory-items.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { suppliers } from "./suppliers.js";

/**
 * P3-20: which inventory items a given supplier actually supplies — a
 * plain link, not a price (that's supplier_item_prices.ts's own append-
 * only job). `supplierSku` is the supplier's own reference code for this
 * item on their invoices/catalogs, not this restaurant's own SKU
 * (inventory_items.ts already has one of those) — nullable, since not
 * every supplier hands out a code. At most one link per (supplier, item)
 * pair — re-linking is an update to `supplierSku`, not a second row.
 * A plain row to delete, unlike suppliers.ts's own soft-disable: a stopped
 * supply relationship has no history worth keeping the way a supplier's
 * own identity (named on past purchase orders, P3-21+) does.
 */
export const supplierItems = pgTable(
  "supplier_items",
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
    supplierSku: text("supplier_sku"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("supplier_items_supplier_item_idx").on(table.supplierId, table.itemId),
    pgPolicy("supplier_items_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
