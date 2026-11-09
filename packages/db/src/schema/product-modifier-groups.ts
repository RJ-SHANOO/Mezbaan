import { integer, pgPolicy, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { modifierGroups } from "./modifier-groups.js";
import { products } from "./products.js";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/** P2-02: attaches a reusable modifier group to a specific product. */
export const productModifierGroups = pgTable(
  "product_modifier_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    modifierGroupId: uuid("modifier_group_id")
      .notNull()
      .references(() => modifierGroups.id),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("product_modifier_groups_product_group_idx").on(table.productId, table.modifierGroupId),
    pgPolicy("product_modifier_groups_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
