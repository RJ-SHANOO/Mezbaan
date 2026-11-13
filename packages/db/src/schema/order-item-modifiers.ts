import { sql } from "drizzle-orm";
import { bigint, integer, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { modifierOptions } from "./modifier-options.js";
import { orderItems } from "./order-items.js";
import { priceLists } from "./price-lists.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P2-12: one selected modifier option on a cart line. Unlike order_items,
 * `unitPriceMinor` defaults to 0 and `priceListId`/`priceListVersion` are
 * nullable: most modifier selections (e.g. "no onions") are genuinely free
 * customizations with nothing to price, and price_list_items.modifierOptionId
 * is an optional price delta, not a requirement — OrderItemsService only
 * refuses to add the *item itself* with no price, never a modifier.
 */
export const orderItemModifiers = pgTable(
  "order_item_modifiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id),
    modifierOptionId: uuid("modifier_option_id")
      .notNull()
      .references(() => modifierOptions.id),
    quantity: integer("quantity").notNull().default(1),
    unitPriceMinor: bigint("unit_price_minor", { mode: "bigint" }).notNull().default(sql`0`),
    currency: text("currency").notNull(),
    priceListId: uuid("price_list_id").references(() => priceLists.id),
    priceListVersion: integer("price_list_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("order_item_modifiers_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
