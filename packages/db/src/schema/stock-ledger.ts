import { numeric, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
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
 * No unit cost here yet — weighted average costing with a per-movement
 * snapshot is P3-11's job specifically, same "primitive now, real costing
 * later" split as P3-07/P3-08's own baseUnit history. No reference to a
 * purchase order, sale or stock count either — those tables don't exist
 * yet (P3-17/P3-21/P3-26); `note` is a free-text placeholder for human
 * context until a real typed reference is worth adding.
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
