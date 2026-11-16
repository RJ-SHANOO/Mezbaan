import { pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { shifts } from "./shifts.js";
import { users } from "./users.js";

/**
 * P2-28: an append-only log of every time the cash drawer was opened during
 * a shift — loss-prevention/audit trail (rule 6), not hardware control
 * (that's P2-34's ESC/POS drawer-kick, later in the task list). `trigger`
 * records WHY it opened: a manual "no sale" open, a cash-in/cash-out
 * movement (CashMovementsService logs one of these automatically — moving
 * physical cash implies the drawer opened), or the shift's own open/close.
 */
export const cashDrawerOpenEvents = pgTable(
  "cash_drawer_open_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    shiftId: uuid("shift_id")
      .notNull()
      .references(() => shifts.id),
    trigger: text("trigger", { enum: ["no_sale", "cash_in", "cash_out", "shift_open", "shift_close", "manual"] }).notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("cash_drawer_open_events_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
