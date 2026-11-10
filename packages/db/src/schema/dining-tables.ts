import { integer, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { floors } from "./floors.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P2-07: a physical dining table — floor layout position, seat count,
 * status and its QR code record. `branchId` is denormalized from the
 * floor it belongs to (DiningTablesService derives it, the client never
 * supplies it directly) purely for direct branch-scoped queries, the same
 * convenience several other branch-scoped tables in this schema keep
 * alongside a more specific parent reference.
 *
 * `status` is a plain settable field with no transition rules yet — there's
 * no order flow (P2-09/P2-13) to drive it automatically, so for now it's
 * whatever the last caller set it to. "Status colors" (the task's own
 * wording) is a presentation concern: the five status values below map to
 * colors in whichever admin/POS screen eventually renders them, not a
 * configurable color stored here — nothing else in this schema stores a
 * color as data either.
 *
 * `qrToken` is a server-generated opaque identifier meant to be embedded in
 * a QR code's URL and scanned by any customer sitting at the table — unlike
 * tokenHash on devices/user_invitations, this is deliberately NOT hashed:
 * those protect a one-time secret that grants a privileged action, while a
 * table's QR code is intentionally public (printed on the table, scanned by
 * anyone) and carries no privilege by itself. Globally unique, since P4-01's
 * QR scan endpoint will look a table up by this value alone, with no
 * restaurant/branch qualifier in the URL to disambiguate it.
 */
export const diningTables = pgTable(
  "dining_tables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    floorId: uuid("floor_id")
      .notNull()
      .references(() => floors.id),
    name: text("name").notNull(),
    seatCount: integer("seat_count").notNull().default(2),
    positionX: integer("position_x"),
    positionY: integer("position_y"),
    status: text("status", { enum: ["available", "occupied", "reserved", "cleaning", "out_of_service"] })
      .notNull()
      .default("available"),
    qrToken: text("qr_token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("dining_tables_branch_name_idx").on(table.branchId, table.name),
    uniqueIndex("dining_tables_qr_token_idx").on(table.qrToken),
    pgPolicy("dining_tables_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
