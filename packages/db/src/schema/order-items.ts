import { sql } from "drizzle-orm";
import { bigint, check, integer, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { invoices } from "./invoices.js";
import { orders } from "./orders.js";
import { priceLists } from "./price-lists.js";
import { productVariants } from "./product-variants.js";
import { products } from "./products.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { users } from "./users.js";

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
    // P2-15: when this item was fired to the kitchen, and by whom — both null
    // until the first fire. Nullable rather than a boolean so "already sent"
    // (rule 16: never silently track state with no timestamp of its own) is
    // visible without a second column, and so a later void/reprint feature
    // (P2-23's job) can tell whether an item ever reached the kitchen at all.
    firedAt: timestamp("fired_at", { withTimezone: true }),
    firedByUserId: uuid("fired_by_user_id").references(() => users.id),
    // P2-21: set once this item has been billed on a split invoice — null
    // means "not yet invoiced." A closed order's items are either all billed
    // on one invoice (the P2-18 default, no splitting) or spread across
    // several (P2-21's "split by item"/"split by seat") — either way, an
    // item can be billed on at most one invoice, which is the real
    // invariant P2-18's old "one invoice per order" UNIQUE index used to
    // stand in for before splitting existed.
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    // P2-22: at most one of these two is ever set — never both, and neither
    // mutates unitPriceMinor itself (rule 6: a discount is a recorded
    // reduction, not a silently-changed price). discountApprovedByUserId is
    // null when the discount was within the cashier's own pos.sell authority
    // (DiscountsService.applyItemDiscount) — set only when it needed a
    // manager's PIN (ManagerPinService, P1-13's first real consumer).
    discountPercentBasisPoints: integer("discount_percent_basis_points"),
    discountAmountMinor: bigint("discount_amount_minor", { mode: "bigint" }),
    discountReasonCode: text("discount_reason_code"),
    discountApprovedByUserId: uuid("discount_approved_by_user_id").references(() => users.id),
    // P2-23: a void keeps the row (rule 6: "visible in reports" — a deleted row
    // isn't) rather than deleting it like OrderItemsService.removeItem does.
    // voidedAt null means "not voided." Approval is required only when
    // firedAt was already set at the moment of voiding — voiding something
    // the kitchen never started on needs no manager sign-off, voiding
    // something already fired does (VoidsService checks firedAt, not a
    // configurable limit like P2-22's discounts — "before or after firing"
    // is itself the whole rule here).
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedByUserId: uuid("voided_by_user_id").references(() => users.id),
    voidReasonCode: text("void_reason_code"),
    voidApprovedByUserId: uuid("void_approved_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "order_items_exactly_one_product_or_variant",
      sql`(${table.productId} IS NOT NULL AND ${table.variantId} IS NULL) OR (${table.productId} IS NULL AND ${table.variantId} IS NOT NULL)`,
    ),
    check(
      "order_items_at_most_one_discount_type",
      sql`NOT (${table.discountPercentBasisPoints} IS NOT NULL AND ${table.discountAmountMinor} IS NOT NULL)`,
    ),
    pgPolicy("order_items_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
