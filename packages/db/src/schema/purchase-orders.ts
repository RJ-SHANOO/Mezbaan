import { pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { suppliers } from "./suppliers.js";
import { users } from "./users.js";

/**
 * P3-21: a branch's order placed with a supplier. Branch-scoped, not
 * restaurant-wide — central purchasing across branches is its own, later
 * task (P4-13), not this one. `status` walks forward through exactly the
 * five states this task names: draft (still editable, PurchaseOrdersService
 * .replaceItems) -> approved (ManagerPinService, same pattern P2-22/23/24
 * already established) -> sent (dispatched to the supplier) -> partly_received
 * / closed. The last two are deliberately not driven by anything in this
 * task — P3-22's goods-received-notes flow (partial delivery, price
 * differences, rejected items) is what actually moves a PO into either one,
 * by comparing against purchase_order_items.receivedQuantity (also this
 * task's column, also not written by anything here beyond its zero
 * default) — the same "primitive now, consumer later" split as P3-09's
 * stock_ledger movement types sitting unused until P3-16/17 became their
 * real callers. Mutable, not append-only: a draft/approved/sent order is
 * a living document moving through its own lifecycle, same precedent as
 * orders.ts/shifts.ts, not a completed financial fact like invoices.ts.
 */
export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    status: text("status", { enum: ["draft", "approved", "sent", "partly_received", "closed"] })
      .notNull()
      .default("draft"),
    currency: text("currency").notNull(),
    note: text("note"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("purchase_orders_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
