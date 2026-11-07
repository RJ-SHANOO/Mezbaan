import { randomUUID } from "node:crypto";
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Pool } from "pg";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import {
  AuditLogService,
  DATABASE,
  DeviceService,
  DEV_JWT_SECRET,
  PermissionGuard,
  PermissionsService,
  ReleasesService,
  TenantContextGuard,
} from "@mezbaan/nest-core";
import { AppModule } from "./app.module.js";

/** Real HTTP coverage for the dynamic update-check endpoint (P1-21): device-token
 * auth, staged rollout gating, and the rollback-override path, against the actual
 * api-pos app. Service-level bucket math and query logic already has focused unit
 * tests in packages/nest-core; this is the "does the wiring actually work" layer. */
const SECRET = process.env.JWT_SECRET ?? DEV_JWT_SECRET;
const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let app: NestFastifyApplication;
let pool: Pool;
let db: Database;
let deviceService: DeviceService;
let releasesService: ReleasesService;

beforeAll(async () => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  deviceService = new DeviceService(db, new AuditLogService(db));
  releasesService = new ReleasesService(db);

  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  app.useGlobalGuards(
    new TenantContextGuard({ secret: SECRET }),
    new PermissionGuard(new PermissionsService(app.get<Database>(DATABASE)), app.get(Reflector)),
  );
  await app.init();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

interface PairedDevice {
  restaurantId: string;
  ownerUserId: string;
  deviceId: string;
  deviceToken: string;
}

async function pairedDeviceToken(label: string): Promise<PairedDevice> {
  const restaurantRows = await withTenant(db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
    tx
      .insert(schema.restaurants)
      .values({ name: label, slug: `${label}-${randomUUID()}`, commissionRateBasisPoints: 500 })
      .returning({ id: schema.restaurants.id }),
  );
  const restaurant = restaurantRows[0];
  if (!restaurant) throw new Error("fixture: restaurant insert returned no row");

  const roleRows = await db
    .insert(schema.roles)
    .values({ key: "owner", name: "Restaurant Owner" })
    .onConflictDoUpdate({ target: schema.roles.key, set: { name: "Restaurant Owner" } })
    .returning({ id: schema.roles.id });
  const role = roleRows[0];
  if (!role) throw new Error("fixture: role insert returned no row");

  const { branchId, ownerUserId } = await withTenant(db, { restaurantId: restaurant.id }, async (tx) => {
    const branchRows = await tx
      .insert(schema.branches)
      .values({ restaurantId: restaurant.id, name: "Main", timezone: "Asia/Karachi" })
      .returning({ id: schema.branches.id });
    const branch = branchRows[0];
    if (!branch) throw new Error("fixture: branch insert returned no row");
    const ownerRows = await tx
      .insert(schema.users)
      .values({ restaurantId: restaurant.id, roleId: role.id, email: `${label}@example.test`, passwordHash: "unused", displayName: label })
      .returning({ id: schema.users.id });
    const owner = ownerRows[0];
    if (!owner) throw new Error("fixture: user insert returned no row");
    return { branchId: branch.id, ownerUserId: owner.id };
  });

  const device = await deviceService.create({
    restaurantId: restaurant.id,
    actorUserId: ownerUserId,
    branchId,
    label: `${label}-device`,
    deviceType: "pos_terminal",
  });
  const { pairingCode } = await deviceService.generatePairingCode({
    restaurantId: restaurant.id,
    actorUserId: ownerUserId,
    deviceId: device.id,
  });
  const { deviceToken } = await deviceService.redeemPairingCode(pairingCode);
  return { restaurantId: restaurant.id, ownerUserId, deviceId: device.id, deviceToken };
}

/** Tauri's endpoint template substitutes {{target}} and {{arch}} as two separate
 * path segments; our `platform` column stores them joined as "target-arch" (see
 * ReleasesController). This fixture's generated platform names ("windows-<uuid>")
 * only have one hyphen, so a plain split on the first "-" round-trips correctly. */
function checkUrl(platform: string, currentVersion: string): string {
  const separator = platform.indexOf("-");
  const target = platform.slice(0, separator);
  const arch = platform.slice(separator + 1);
  return `/releases/check/${target}/${arch}/${currentVersion}`;
}

describe("GET /releases/check/:target/:arch/:currentVersion", () => {
  it("requires a device token", async () => {
    const response = await app.inject({ method: "GET", url: "/releases/check/windows/x86_64/1.0.0" });
    expect(response.statusCode).toBe(401);
  });

  it("returns 204 when there's no release published for the platform yet", async () => {
    const { deviceToken } = await pairedDeviceToken("rel-none");
    const response = await app.inject({
      method: "GET",
      url: checkUrl(`no-such-os-${randomUUID()}`, "1.0.0"),
      headers: { "x-device-token": deviceToken },
    });
    expect(response.statusCode).toBe(204);
  });

  it("returns the manifest when the device's rollout bucket is included", async () => {
    const { deviceId, deviceToken } = await pairedDeviceToken("rel-included");
    const platform = `windows-${randomUUID()}`;
    const bucket = releasesService.rolloutBucket(deviceId);
    await db.insert(schema.appReleases).values({
      platform,
      version: "9.0.0",
      url: "https://example.test/update.msi.zip",
      signature: "sig",
      rolloutPercentage: bucket + 1,
    });

    const response = await app.inject({
      method: "GET",
      url: checkUrl(platform, "1.0.0"),
      headers: { "x-device-token": deviceToken },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ version: string }>().version).toBe("9.0.0");
  });

  it("returns 204 when the device's rollout bucket is excluded", async () => {
    const { deviceId, deviceToken } = await pairedDeviceToken("rel-excluded");
    const platform = `windows-${randomUUID()}`;
    const bucket = releasesService.rolloutBucket(deviceId);
    await db.insert(schema.appReleases).values({
      platform,
      version: "9.0.0",
      url: "https://example.test/update.msi.zip",
      signature: "sig",
      rolloutPercentage: bucket,
    });

    const response = await app.inject({
      method: "GET",
      url: checkUrl(platform, "1.0.0"),
      headers: { "x-device-token": deviceToken },
    });
    expect(response.statusCode).toBe(204);
  });

  it("the X-Rollback-To-Version header bypasses rollout gating entirely", async () => {
    const { deviceId, deviceToken } = await pairedDeviceToken("rel-rollback");
    const platform = `windows-${randomUUID()}`;
    const bucket = releasesService.rolloutBucket(deviceId);
    await db.insert(schema.appReleases).values([
      { platform, version: "0.9.0", url: "https://example.test/old.msi.zip", signature: "sig-old", rolloutPercentage: 0 },
      { platform, version: "2.0.0", url: "https://example.test/new.msi.zip", signature: "sig-new", rolloutPercentage: bucket },
    ]);

    const response = await app.inject({
      method: "GET",
      url: checkUrl(platform, "1.0.0"),
      headers: { "x-device-token": deviceToken, "x-rollback-to-version": "0.9.0" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ version: string }>().version).toBe("0.9.0");
  });

  it("a revoked device's token is rejected here too", async () => {
    const { restaurantId, ownerUserId, deviceId, deviceToken } = await pairedDeviceToken("rel-revoked");
    await deviceService.revoke({ restaurantId, actorUserId: ownerUserId, deviceId });

    const response = await app.inject({
      method: "GET",
      url: checkUrl("windows-x86_64", "1.0.0"),
      headers: { "x-device-token": deviceToken },
    });
    expect(response.statusCode).toBe(401);
  });
});
