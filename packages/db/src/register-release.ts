import { createDb, createPool, type Database } from "./client.js";
import { appReleases } from "./schema/index.js";
import { DEFAULT_ADMIN_URL } from "./seed.js";

export interface RegisterReleaseParams {
  platform: string;
  version: string;
  url: string;
  signature: string;
  notes?: string | null;
  /** 0-100. The staged-rollout knob (P1-21) — re-running this for the same
   * platform+version with a higher value is how a rollout gets widened over time. */
  rolloutPercentage: number;
}

export interface RegisterReleaseResult {
  platform: string;
  version: string;
  rolloutPercentage: number;
}

export async function runRegisterRelease(db: Database, params: RegisterReleaseParams): Promise<RegisterReleaseResult> {
  if (params.rolloutPercentage < 0 || params.rolloutPercentage > 100) {
    throw new Error(`register-release: rolloutPercentage must be 0-100, got ${params.rolloutPercentage}`);
  }

  const rows = await db
    .insert(appReleases)
    .values({
      platform: params.platform,
      version: params.version,
      url: params.url,
      signature: params.signature,
      notes: params.notes ?? null,
      rolloutPercentage: params.rolloutPercentage,
    })
    .onConflictDoUpdate({
      target: [appReleases.platform, appReleases.version],
      set: { url: params.url, signature: params.signature, notes: params.notes ?? null, rolloutPercentage: params.rolloutPercentage },
    })
    .returning({ platform: appReleases.platform, version: appReleases.version, rolloutPercentage: appReleases.rolloutPercentage });

  const release = rows[0];
  if (!release) throw new Error("register-release: insert/update returned no row");
  return release;
}

export async function runRegisterReleaseStandalone(
  params: RegisterReleaseParams,
  connectionString: string = DEFAULT_ADMIN_URL,
): Promise<RegisterReleaseResult> {
  const pool = createPool(connectionString);
  const db = createDb(pool);
  try {
    return await runRegisterRelease(db, params);
  } finally {
    await pool.end();
  }
}
