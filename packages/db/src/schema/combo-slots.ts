import { integer, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { combos } from "./combos.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P2-03: one position within a combo (e.g. "Main", "Side", "Drink"). `kind`
 * distinguishes the two cases the task asks for:
 *  - "fixed": always exactly one item, never a customer choice (e.g. "comes
 *    with regular fries"). The service layer pins minSelections/maxSelections
 *    to 1 and rejects a second item ever being attached to this slot.
 *  - "choice": the customer picks from whatever combo_slot_items.ts offers for
 *    this slot, same minSelections/maxSelections pair as modifier_groups.ts
 *    (P2-02) — required-vs-optional and the choice-count limit expressed
 *    together rather than as a separate boolean.
 */
export const comboSlots = pgTable(
  "combo_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    comboId: uuid("combo_id")
      .notNull()
      .references(() => combos.id),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["fixed", "choice"] }).notNull(),
    minSelections: integer("min_selections").notNull().default(1),
    maxSelections: integer("max_selections"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("combo_slots_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
