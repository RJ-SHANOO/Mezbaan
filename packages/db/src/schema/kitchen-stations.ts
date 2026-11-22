import { integer, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P3-01: a kitchen prep station (e.g. "Grill", "Fryer", "Salad", "Bar") at one
 * branch. Always branch-scoped, same reasoning as floors.ts — kitchen
 * equipment differs per physical location, so there's no sensible
 * restaurant-wide default station.
 *
 * P3-04: printerHost/printerPort are this station's own network ESC/POS
 * printer — a shared branch resource any terminal can send a ticket to over
 * the LAN, unlike a POS terminal's own receipt printer (P2-35's
 * printer_settings.rs, local to one device). Null means "no printer
 * configured" — the ticket still shows on the Kitchen Display either way
 * (rule 14: a printer failure, or none at all, must never block a ticket
 * from reaching the kitchen). USB is deliberately not supported here — a
 * USB printer is only reachable from the one PC it's plugged into, which
 * doesn't fit "any firing terminal can print to this station."
 */
export const kitchenStations = pgTable(
  "kitchen_stations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    printerHost: text("printer_host"),
    printerPort: integer("printer_port"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("kitchen_stations_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
