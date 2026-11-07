import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool, schema, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { ReleasesService } from "./releases.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: ReleasesService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  service = new ReleasesService(db);
});

afterAll(async () => {
  await pool.end();
});

async function insertRelease(overrides: Partial<typeof schema.appReleases.$inferInsert> = {}) {
  const rows = await db
    .insert(schema.appReleases)
    .values({
      platform: "windows-x86_64",
      version: "1.1.0",
      url: "https://example.test/mezbaan-desktop_1.1.0_x64.msi.zip",
      signature: "fake-signature",
      rolloutPercentage: 0,
      ...overrides,
    })
    .returning();
  const release = rows[0];
  if (!release) throw new Error("fixture: release insert returned no row");
  return release;
}

describe("rolloutBucket()", () => {
  it("is deterministic for the same device id", () => {
    const deviceId = randomUUID();
    const first = service.rolloutBucket(deviceId);
    const second = service.rolloutBucket(deviceId);
    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(100);
  });

  it("spreads different device ids across the bucket range (not all the same bucket)", () => {
    const buckets = new Set(Array.from({ length: 50 }, () => service.rolloutBucket(randomUUID())));
    expect(buckets.size).toBeGreaterThan(1);
  });
});

describe("checkForUpdate()", () => {
  it("returns null when there's no release for the platform", async () => {
    const result = await service.checkForUpdate({
      platform: `no-such-platform-${randomUUID()}`,
      currentVersion: "1.0.0",
      deviceId: randomUUID(),
    });
    expect(result).toBeNull();
  });

  it("returns the manifest when the device's bucket is inside the rollout percentage", async () => {
    const platform = `test-${randomUUID()}`;
    const deviceId = randomUUID();
    const bucket = service.rolloutBucket(deviceId);
    await insertRelease({ platform, version: "2.0.0", rolloutPercentage: bucket + 1 });

    const result = await service.checkForUpdate({ platform, currentVersion: "1.0.0", deviceId });
    expect(result).toEqual({
      version: "2.0.0",
      notes: null,
      pub_date: expect.any(String),
      url: "https://example.test/mezbaan-desktop_1.1.0_x64.msi.zip",
      signature: "fake-signature",
    });
  });

  it("returns null when the device's bucket is outside the rollout percentage", async () => {
    const platform = `test-${randomUUID()}`;
    const deviceId = randomUUID();
    const bucket = service.rolloutBucket(deviceId);
    await insertRelease({ platform, version: "2.0.0", rolloutPercentage: bucket });

    const result = await service.checkForUpdate({ platform, currentVersion: "1.0.0", deviceId });
    expect(result).toBeNull();
  });

  it("never offers the device's own current version as an update, even at 100% rollout", async () => {
    const platform = `test-${randomUUID()}`;
    const deviceId = randomUUID();
    await insertRelease({ platform, version: "1.0.0", rolloutPercentage: 100 });

    const result = await service.checkForUpdate({ platform, currentVersion: "1.0.0", deviceId });
    expect(result).toBeNull();
  });

  it("picks the most recently published release for the platform", async () => {
    const platform = `test-${randomUUID()}`;
    const deviceId = randomUUID();
    await insertRelease({ platform, version: "2.0.0", rolloutPercentage: 100, publishedAt: new Date("2026-01-01") });
    await insertRelease({ platform, version: "3.0.0", rolloutPercentage: 100, publishedAt: new Date("2026-06-01") });

    const result = await service.checkForUpdate({ platform, currentVersion: "1.0.0", deviceId });
    expect(result?.version).toBe("3.0.0");
  });

  it("rollbackToVersion returns that exact version's manifest regardless of rollout percentage", async () => {
    const platform = `test-${randomUUID()}`;
    const deviceId = randomUUID();
    const bucket = service.rolloutBucket(deviceId);
    // 0% rollout — would never be offered as a normal update.
    await insertRelease({ platform, version: "0.9.0", rolloutPercentage: 0, publishedAt: new Date("2025-01-01") });
    await insertRelease({ platform, version: "2.0.0", rolloutPercentage: bucket, publishedAt: new Date("2026-06-01") });

    const result = await service.checkForUpdate({
      platform,
      currentVersion: "1.0.0",
      deviceId,
      rollbackToVersion: "0.9.0",
    });
    expect(result?.version).toBe("0.9.0");
  });

  it("rollbackToVersion returns null when that version was never published for the platform", async () => {
    const platform = `test-${randomUUID()}`;
    const result = await service.checkForUpdate({
      platform,
      currentVersion: "1.0.0",
      deviceId: randomUUID(),
      rollbackToVersion: "0.1.0",
    });
    expect(result).toBeNull();
  });
});
