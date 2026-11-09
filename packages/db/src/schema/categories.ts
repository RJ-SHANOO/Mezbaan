import { integer, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P2-01: menu categories. Restaurant-scoped, not branch-scoped — a category
 * (e.g. "Burgers", "Beverages") is the same concept across every branch; which
 * branches actually carry which products underneath it is products.ts's
 * per-branch availability, not a category-level concern.
 */
export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    name: text("name").notNull(),
    // Menu display order, lowest first. Plain integer, not a DB-enforced
    // sequence — callers can freely renumber/reorder without gaps mattering.
    sortOrder: integer("sort_order").notNull().default(0),
    status: text("status", { enum: ["active", "inactive"] })
      .notNull()
      .default("active"),
    // A reference only (P2-01 scope) — the actual upload-to-storage pipeline with
    // resizing/optimization is P2-44's job, same "generic primitive now, real
    // pipeline later" split as several Phase 1 tasks.
    imageUrl: text("image_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("categories_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
