import { bigint, numeric, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { invoices } from "./invoices.js";
import { inventoryItems } from "./inventory-items.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { storageLocations } from "./storage-locations.js";
import { users } from "./users.js";

/**
 * P3-09: every stock movement, ever — append-only (rule 4's "never update
 * or delete" convention, same enforcement as invoices/payments/refunds/
 * credit_ledger_entries; UPDATE/DELETE revoked in app-role.ts). Branch and
 * location stock levels are *derived* from summing this table (P3-10's
 * job), never stored directly — this table is the only source of truth.
 *
 * `quantityDelta` is signed (positive = stock increase, negative =
 * decrease), unlike credit_ledger_entries' magnitude-plus-type convention
 * — a "count" or "adjustment" movement can go either direction depending
 * on what was actually found, so the type alone can't imply a sign the
 * way "charge"/"repayment" can. Always in the item's own base unit
 * (inventory_items.baseUnitId, P3-08) — a caller recording a movement in a
 * different unit (e.g. a purchase received in cartons) converts first via
 * packages/domain's convertQuantity, so this table never has to.
 *
 * `transferGroupId` links the two rows one "transfer" movement always
 * produces — a negative entry at the source location and a positive one
 * at the destination, both carrying the same group id — rather than one
 * row with two location columns, so every row here always means exactly
 * one location's stock changing by exactly one signed amount, with no
 * special case for transfers. Null for every other movement type.
 *
 * P3-16: `productionBatchId` is the same linking idea for a production
 * batch — one negative "production" row per ingredient consumed, plus
 * one positive "production" row for the finished semi-finished item,
 * all sharing one id. A dedicated column rather than reusing
 * transferGroupId: the two concepts are unrelated movement shapes (a
 * transfer is always exactly two rows; a batch is one-per-ingredient
 * plus one), and transferGroupId is already a live column this task
 * shouldn't repurpose into a different meaning.
 *
 * P3-11: `unitCostMinor`/`currency` snapshot what THIS movement's own
 * units were worth at the moment it happened — not necessarily the
 * resulting average. For an increase (purchase/return/production/a
 * positive adjustment or count) with a caller-supplied cost, it's that
 * raw delivery cost verbatim (the price actually paid, kept distinct from
 * whatever the blended average becomes — stock_levels.averageCostMinor
 * holds that); for an increase with no cost supplied, or any decrease
 * (sale/wastage/transfer-out/negative count or adjustment), it's simply
 * the average that was already current at that moment, since there's no
 * new cost information to record and a decrease never changes the
 * average anyway. Null only when the item had never had a costed
 * movement at this location before. Money, so rule 5 applies: an integer
 * in minor units, computed exclusively via packages/domain's
 * blendWeightedAverageCost — never by hand.
 *
 * P3-17: `invoiceId` is the same linking idea again, this time for a sale —
 * every ingredient a sold item's (and its selected modifiers') recipe
 * calls for produces one negative "sale" row per distinct ingredient,
 * all sharing the invoice that caused them (SalesStockDeductionService).
 * Unlike transferGroupId/productionBatchId this one's a real FK to an
 * existing document rather than a synthetic id, since the invoice already
 * exists before deduction runs. Still no reference for a purchase order or
 * stock count (P3-21/P3-26 respectively); `note` remains the free-text
 * placeholder for those until a real typed reference is worth adding.
 */
export const stockLedger = pgTable(
  "stock_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    storageLocationId: uuid("storage_location_id")
      .notNull()
      .references(() => storageLocations.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => inventoryItems.id),
    movementType: text("movement_type", {
      enum: ["purchase", "sale", "return", "wastage", "adjustment", "count", "production", "transfer"],
    }).notNull(),
    quantityDelta: numeric("quantity_delta", { mode: "number", precision: 18, scale: 6 }).notNull(),
    transferGroupId: uuid("transfer_group_id"),
    productionBatchId: uuid("production_batch_id"),
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    unitCostMinor: bigint("unit_cost_minor", { mode: "bigint" }),
    currency: text("currency"),
    note: text("note"),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("stock_ledger_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
