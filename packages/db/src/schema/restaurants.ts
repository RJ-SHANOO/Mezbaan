import { sql } from "drizzle-orm";
import { integer, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { isSuperAdmin, selfTenantMatch } from "./rls.js";

/**
 * The tenant root. Unlike every other table here, there's no pre-existing
 * `restaurant_id` to check an INSERT against — a brand-new restaurant doesn't have a
 * row yet, so CREATE is left open at the RLS level and gated by the signup flow (P1-15)
 * instead. Reads/updates are still scoped to the caller's own restaurant, and hard
 * delete is restricted to super-admin sessions only.
 *
 * Note for whoever builds P1-15: run the actual INSERT with `isSuperAdmin: true` (no
 * tenant to be yet). Without it, `INSERT ... RETURNING` fails — Postgres also checks
 * the SELECT policy against the row it's about to return, and a row with no matching
 * tenant context isn't visible to anyone but a super-admin session.
 */
export const restaurants = pgTable(
  "restaurants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    status: text("status", { enum: ["active", "suspended"] })
      .notNull()
      .default("active"),
    // Locked at registration (rule 7): later plan changes never alter past commission
    // entries, which snapshot the rate that was in effect at the time.
    commissionRateBasisPoints: integer("commission_rate_basis_points").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    pgPolicy("restaurants_select", {
      for: "select",
      using: selfTenantMatch(table.id),
    }),
    pgPolicy("restaurants_insert", {
      for: "insert",
      withCheck: sql`true`,
    }),
    pgPolicy("restaurants_update", {
      for: "update",
      using: selfTenantMatch(table.id),
      withCheck: selfTenantMatch(table.id),
    }),
    pgPolicy("restaurants_delete", {
      for: "delete",
      using: isSuperAdmin,
    }),
  ],
).enableRLS();
