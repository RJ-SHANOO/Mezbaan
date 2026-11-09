import { sql } from "drizzle-orm";
import { integer, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P2-04: a versioned price list. "Versioned" is real, not just a label — once
 * `status` moves to "published" this row's scope and its price_list_items.ts
 * entries are never mutated again (rule 3/rule 4's spirit: a synced sale must
 * always be checkable against the exact price version that was in effect).
 * A price change is a brand-new row, never an edit to a published one.
 *
 * `version` is sequential per (restaurant, name) — "Standard Menu" v1, v2,
 * v3 — assigned by a BEFORE INSERT trigger (see the migration), same pattern
 * and same reasoning as branch_number/terminal_number (P1-28): every insert
 * path gets a correct number without duplicating the logic app-side, and the
 * UNIQUE index below is the real guarantee against a concurrent-publish race.
 *
 * The three scoping dimensions the task asks for are all nullable, meaning
 * "applies universally" on that dimension: `branchId` null = every branch,
 * `orderType` null = every order type, and `effectiveFrom`/`effectiveTo` null
 * = no start/end boundary on that side. `priority` breaks ties when more than
 * one published list matches the same moment (e.g. a "Happy Hour" list and
 * the year-round "Standard" list both covering 4pm on a Tuesday) — higher
 * wins; PriceResolutionService also prefers the more specifically-scoped list
 * before falling back to priority order.
 */
export const priceLists = pgTable(
  "price_lists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    name: text("name").notNull(),
    version: integer("version").notNull().default(sql`NULL`),
    currency: text("currency").notNull(),
    branchId: uuid("branch_id").references(() => branches.id),
    orderType: text("order_type", { enum: ["dine_in", "takeaway", "delivery"] }),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    priority: integer("priority").notNull().default(0),
    status: text("status", { enum: ["draft", "published", "archived"] })
      .notNull()
      .default("draft"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("price_lists_restaurant_name_version_idx").on(table.restaurantId, table.name, table.version),
    pgPolicy("price_lists_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
