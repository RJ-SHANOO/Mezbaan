import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { createDb, createPool, type Database } from "./client.js";
import { runRegisterRelease } from "./register-release.js";
import { appReleases } from "./schema/index.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
});

afterAll(async () => {
  await pool.end();
});

describe("runRegisterRelease()", () => {
  it("inserts a new release", async () => {
    const platform = `test-${randomUUID()}`;
    const result = await runRegisterRelease(db, {
      platform,
      version: "1.0.0",
      url: "https://example.test/a.msi.zip",
      signature: "sig",
      rolloutPercentage: 10,
    });
    expect(result).toEqual({ platform, version: "1.0.0", rolloutPercentage: 10 });
  });

  it("re-registering the same platform+version updates it instead of duplicating (the widen-the-rollout path)", async () => {
    const platform = `test-${randomUUID()}`;
    await runRegisterRelease(db, {
      platform,
      version: "1.0.0",
      url: "https://example.test/a.msi.zip",
      signature: "sig-a",
      rolloutPercentage: 10,
    });
    await runRegisterRelease(db, {
      platform,
      version: "1.0.0",
      url: "https://example.test/a.msi.zip",
      signature: "sig-b",
      rolloutPercentage: 50,
    });

    const rows = await db.select().from(appReleases).where(eq(appReleases.platform, platform));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rolloutPercentage).toBe(50);
    expect(rows[0]?.signature).toBe("sig-b");
  });

  it("rejects a rollout percentage outside 0-100", async () => {
    const platform = `test-${randomUUID()}`;
    await expect(
      runRegisterRelease(db, { platform, version: "1.0.0", url: "https://example.test/a.msi.zip", signature: "sig", rolloutPercentage: 101 }),
    ).rejects.toThrow();
    await expect(
      runRegisterRelease(db, { platform, version: "1.0.0", url: "https://example.test/a.msi.zip", signature: "sig", rolloutPercentage: -1 }),
    ).rejects.toThrow();
  });
});
