import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * A global reference table, not a tenant table (same reasoning as roles.ts): a
 * desktop release applies platform-wide, not per restaurant. No RLS: rule 2 only
 * requires it for tenant tables.
 *
 * One row per (platform, version) — see the unique index below. `rolloutPercentage`
 * is the staged-rollout knob (P1-21): ReleasesService buckets each device
 * deterministically into 0-99 from a hash of its id, and only offers this release to
 * devices whose bucket falls under the percentage. Raising it over time (via
 * packages/db/scripts/register-release.mjs, re-run with a higher --rollout) is what
 * "staged" means here — there's no Super Admin UI yet (P3-39) to turn this knob from.
 */
export const appReleases = pgTable(
  "app_releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Tauri's updater plugin substitutes {{target}} as "<os>-<arch>", e.g.
    // "windows-x86_64", "darwin-aarch64", "linux-x86_64".
    platform: text("platform").notNull(),
    version: text("version").notNull(),
    url: text("url").notNull(),
    signature: text("signature").notNull(),
    notes: text("notes"),
    rolloutPercentage: integer("rollout_percentage").notNull().default(0),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("app_releases_platform_version_idx").on(table.platform, table.version)],
);
