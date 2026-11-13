import { pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { orders } from "./orders.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { users } from "./users.js";

/**
 * P2-13: one row per order status transition, written by OrdersService using
 * packages/domain's state machine as the only path that can produce a row
 * here. Append-only, same convention and enforcement as audit_logs (rule 4's
 * "never update or delete" reasoning, even though this isn't itself a
 * financial table): app-role.ts REVOKEs UPDATE/DELETE from mezbaan_app.
 */
export const orderStatusHistory = pgTable(
  "order_status_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    // Nullable: the very first row for an order (open, on creation) has no prior status.
    fromStatus: text("from_status", { enum: ["open", "held", "closed", "cancelled"] }),
    toStatus: text("to_status", { enum: ["open", "held", "closed", "cancelled"] }).notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("order_status_history_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
