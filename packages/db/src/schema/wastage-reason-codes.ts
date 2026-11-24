import { boolean, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";

/**
 * P3-28: the fixed set of reasons a restaurant allows for an ad-hoc
 * wastage entry (e.g. "spoiled," "dropped/broken," "expired") — a
 * standalone stock loss with no sale, void, or purchase behind it, unlike
 * VoidsService.recordWastage (P3-18, a fired-then-voided item's own
 * ingredients) or goods_rejection_reason_codes.ts (refused at the dock
 * before ever entering stock). Same inclusion-list convention as every
 * other reason-code table in this project.
 */
export const wastageReasonCodes = pgTable(
  "wastage_reason_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    code: text("code").notNull(),
    label: text("label").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("wastage_reason_codes_restaurant_code_idx").on(table.restaurantId, table.code),
    pgPolicy("wastage_reason_codes_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
