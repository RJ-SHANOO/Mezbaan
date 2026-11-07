import { pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches.js";
import { restaurants } from "./restaurants.js";
import { roles } from "./roles.js";
import { users } from "./users.js";
import { tenantMatch } from "./rls.js";

/** An invited-but-not-yet-registered staff member (P1-17). Same "only the hash" rule
 * as password_reset_tokens — the invite token embeds the restaurant id the same way
 * (see opaque-token.ts), since accepting an invite happens before any tenant context
 * exists, same bootstrap problem login/signup have. */
export const userInvitations = pgTable(
  "user_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restaurantId: uuid("restaurant_id")
      .notNull()
      .references(() => restaurants.id),
    branchId: uuid("branch_id").references(() => branches.id),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedByUserId: uuid("invited_by_user_id")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("user_invitations_tenant_isolation", {
      for: "all",
      using: tenantMatch,
      withCheck: tenantMatch,
    }),
  ],
).enableRLS();
