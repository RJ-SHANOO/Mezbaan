import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, ne } from "drizzle-orm";
import { schema, type Database } from "@mezbaan/db";
import type { UpdateManifest } from "@mezbaan/contracts";
import { DATABASE } from "./db.module.js";

export interface CheckForUpdateParams {
  platform: string;
  currentVersion: string;
  deviceId: string;
  /** Set by the client when its own local boot-health tracking has decided the
   * currently-installed version is bad (see apps/desktop's update_health.rs) — asks
   * for this exact version's manifest instead of the latest rollout-gated one,
   * bypassing rolloutPercentage entirely. This is how P1-21's rollback actually
   * works: Tauri's updater client trusts whatever manifest the server hands back
   * (there's no client-side "is this newer?" gate — see Update.available's
   * deprecation note in @tauri-apps/plugin-updater), so returning an *older*
   * version here is exactly what makes the app reinstall it. */
  rollbackToVersion?: string;
}

/**
 * app_releases is a global reference table (no RLS — see its schema file), so this
 * queries the injected Database directly rather than going through withTenant, same
 * as PermissionsService.
 */
@Injectable()
export class ReleasesService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Deterministic 0-99 bucket from a device's own id — stable across every release
   * (never re-randomized), so a device doesn't flip in and out of a rollout on
   * repeated checks. */
  rolloutBucket(deviceId: string): number {
    const hash = createHash("sha256").update(deviceId).digest();
    const firstFourBytes = hash.readUInt32BE(0);
    return firstFourBytes % 100;
  }

  async checkForUpdate(params: CheckForUpdateParams): Promise<UpdateManifest | null> {
    if (params.rollbackToVersion) {
      const rows = await this.db
        .select()
        .from(schema.appReleases)
        .where(and(eq(schema.appReleases.platform, params.platform), eq(schema.appReleases.version, params.rollbackToVersion)));
      const release = rows[0];
      return release ? toManifest(release) : null;
    }

    const rows = await this.db
      .select()
      .from(schema.appReleases)
      .where(and(eq(schema.appReleases.platform, params.platform), ne(schema.appReleases.version, params.currentVersion)))
      .orderBy(desc(schema.appReleases.publishedAt))
      .limit(1);
    const release = rows[0];
    if (!release) return null;

    const bucket = this.rolloutBucket(params.deviceId);
    if (bucket >= release.rolloutPercentage) return null;

    return toManifest(release);
  }
}

function toManifest(release: typeof schema.appReleases.$inferSelect): UpdateManifest {
  return {
    version: release.version,
    notes: release.notes,
    pub_date: release.publishedAt.toISOString(),
    url: release.url,
    signature: release.signature,
  };
}
