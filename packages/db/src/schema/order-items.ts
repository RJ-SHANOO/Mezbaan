import { sql } from "drizzle-orm";
import { bigint, check, integer, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { orders } from "./orders.js";
import { priceLists } from "./price-lists.js";
import { productVariants } from "./product-variants.js";
import { products } from "./products.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P2-12: "the cart" — one line on an order. Exactly one of productId/
 * variantId is set (same convention and same reasoning as price_list_items:
 * which one a caller priced against is its own choice, enforced here with a
 * CHECK constraint the same way orders.ts guards tableId vs orderType).
 *
 * unitPriceMinor/currency/priceListId/priceListVersion are always populated
 * — OrderItemsService resolves and snapshots a real price via
 * PriceResolutionService (P2-04) before a row is ever inserted, and refuses
 * to add an item with no price configured at all (rule 6: never under-report
 * a sale by accidentally selling something for free). priceListId/Version
 * are the "which version was this sale priced against" rule 3 needs for the
 * server to later recheck a synced sale.
 *
 * notes/seatNumber/course are exactly this task's three other asks: free
 * text, a plain integer (no separate seat registry — same "just a number"
 * choice P2-07 made for a table's seatCount), and a free-text label (no
 * managed list of course names — a restaurant's own naming, not something
 * this schema curates). No "sent to kitchen" status here — that's P2-15's
 * job specifically.
 */
export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    productId: uuid("product_id").references(() => products.id),
    variantId: uuid("variant_id").references(() => productVariants.id),
    quantity: integer("quantity").notNull().default(1),
    unitPriceMinor: bigint("unit_price_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    priceListId: uuid("price_list_id")
      .notNull()
      .references(() => priceLists.id),
    priceListVersion: integer("price_list_version").notNull(),
    notes: text("notes"),
    seatNumber: integer("seat_number"),
    course: text("course"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "order_items_exactly_one_product_or_variant",
      sql`(${table.productId} IS NOT NULL AND ${table.variantId} IS NULL) OR (${table.productId} IS NULL AND ${table.variantId} IS NOT NULL)`,
    ),
    pgPolicy("order_items_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
