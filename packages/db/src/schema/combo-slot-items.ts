import { integer, pgPolicy, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { comboSlots } from "./combo-slots.js";
import { products } from "./products.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P2-03: one candidate product for a combo slot. A "fixed" slot has exactly
 * one of these (the service layer enforces that, not this table); a "choice"
 * slot has as many as the menu offers, and the customer picks among them
 * within the slot's min/max.
 */
export const comboSlotItems = pgTable(
  "combo_slot_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    comboSlotId: uuid("combo_slot_id")
      .notNull()
      .references(() => comboSlots.id),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("combo_slot_items_slot_product_idx").on(table.comboSlotId, table.productId),
    pgPolicy("combo_slot_items_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
