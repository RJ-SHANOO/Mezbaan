import { boolean, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { restaurants } from "./restaurants.js";
import { tenantMatch } from "./rls.js";
import { users } from "./users.js";

/**
 * P2-33: what a restaurant's receipt looks like — one row per restaurant
 * (no branch scoping, same reasoning as discount_limit_settings: nothing
 * here calls for a per-branch override). `logoUrl` is just a reference
 * (S3-hosted, rule "Files" in section 3) — converting whatever image lives
 * there into the 1-bit monochrome raster bytes an ESC/POS printer needs is
 * explicitly out of scope here (no image-decoding dependency exists yet);
 * see apps/desktop's receipt_template.rs, where that same gap is documented
 * on the rendering side.
 */
export const receiptSettings = pgTable(
  "receipt_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    logoUrl: text("logo_url"),
    headerText: text("header_text"),
    footerText: text("footer_text"),
    showTaxBreakdown: boolean("show_tax_breakdown").notNull().default(true),
    showServiceCharge: boolean("show_service_charge").notNull().default(true),
    updatedByUserId: uuid("updated_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("receipt_settings_restaurant_idx").on(table.restaurantId),
    pgPolicy("receipt_settings_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
