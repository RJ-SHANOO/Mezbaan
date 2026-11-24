import { sql } from "drizzle-orm";
import { bigint, boolean, check, numeric, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { inventoryItems } from "./inventory-items.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { storageLocations } from "./storage-locations.js";
import { users } from "./users.js";

/**
 * P3-28: an ad-hoc stock loss with no sale, void, or purchase behind it —
 * a real event, so append-only (rule 4's convention, UPDATE/DELETE
 * revoked in app-role.ts) same as goods-received-notes.ts/purchase-
 * returns.ts. `costMinor` is the item's current weighted-average cost
 * (stock_levels.averageCostMinor) times `quantity` at the moment this is
 * recorded — null only when the item had no established cost yet (the
 * same documented understatement P3-16's production costing already
 * accepts), and it's what `requiredApproval`/approval is checked against
 * (wastage-limit-settings.ts), not the raw quantity: a restaurant cares
 * about how much VALUE was lost, not how many units.
 */
export const wastageEntries = pgTable(
  "wastage_entries",
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
    quantity: numeric("quantity", { mode: "number", precision: 18, scale: 6 }).notNull(),
    reasonCode: text("reason_code").notNull(),
    costMinor: bigint("cost_minor", { mode: "bigint" }),
    currency: text("currency"),
    requiredApproval: boolean("required_approval").notNull(),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("wastage_entries_quantity_positive", sql`${table.quantity} > 0`),
    pgPolicy("wastage_entries_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
