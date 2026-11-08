import { randomUUID } from "node:crypto";
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Pool } from "pg";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService, DATABASE, DeviceService, DEV_JWT_SECRET, PermissionGuard, PermissionsService, TenantContextGuard, verifyBytes } from "@mezbaan/nest-core";
import { AppModule } from "./app.module.js";

const SECRET = process.env.JWT_SECRET ?? DEV_JWT_SECRET;
const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let app: NestFastifyApplication;
let pool: Pool;
let db: Database;
let deviceService: DeviceService;

beforeAll(async () => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  deviceService = new DeviceService(db, new AuditLogService(db));

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

async function ownerRoleId(): Promise<string> {
  const rows = await db.insert(schema.roles).values({ key: "owner", name: "Restaurant Owner" }).onConflictDoUpdate({ target: schema.roles.key, set: { name: "Restaurant Owner" } }).returning({ id: schema.roles.id });
  const id = rows[0]?.id;
  if (!id) throw new Error("fixture: role insert returned no row");
  return id;
}

async function createPairedDevice(label: string): Promise<{ restaurantId: string; ownerUserId: string; deviceToken: string }> {
  const restaurantRows = await withTenant(db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
    tx.insert(schema.restaurants).values({ name: label, slug: `${label}-${randomUUID()}`, commissionRateBasisPoints: 500 }).returning({ id: schema.restaurants.id }),
  );
  const restaurantId = restaurantRows[0]?.id;
  if (!restaurantId) throw new Error("fixture: restaurant insert returned no row");

  const { branchId, ownerUserId } = await withTenant(db, { restaurantId }, async (tx) => {
    const branchRows = await tx.insert(schema.branches).values({ restaurantId, name: "Main", timezone: "Asia/Karachi" }).returning({ id: schema.branches.id });
    const branchId = branchRows[0]?.id;
    if (!branchId) throw new Error("fixture: branch insert returned no row");

    const ownerRows = await tx
      .insert(schema.users)
      .values({ restaurantId, branchId, roleId: await ownerRoleId(), email: `${label}@example.test`, passwordHash: "unused", displayName: label })
      .returning({ id: schema.users.id });
    const ownerUserId = ownerRows[0]?.id;
    if (!ownerUserId) throw new Error("fixture: user insert returned no row");

    return { branchId, ownerUserId };
  });

  const device = await deviceService.create({ restaurantId, actorUserId: ownerUserId, branchId, label: `${label}-device`, deviceType: "pos_terminal" });
  const { pairingCode } = await deviceService.generatePairingCode({ restaurantId, actorUserId: ownerUserId, deviceId: device.id });
  const { deviceToken } = await deviceService.redeemPairingCode(pairingCode);
  return { restaurantId, ownerUserId, deviceToken };
}

describe("sync snapshot — HTTP (api-pos, P1-27)", () => {
  it("a paired device fetches a signed, versioned snapshot containing its own staff", async () => {
    const { deviceToken, ownerUserId } = await createPairedDevice("snap-ok");

    const response = await app.inject({ method: "GET", url: "/sync/snapshot", headers: { "x-device-token": deviceToken } });
    expect(response.statusCode).toBe(200);

    const body = response.json<{ version: string; contentJson: string; signature: string }>();
    expect(body.version).toBeTruthy();
    expect(verifyBytes(body.contentJson, body.signature)).toBe(true);

    const content = JSON.parse(body.contentJson) as { staff: Array<{ id: string }> };
    expect(content.staff.map((s) => s.id)).toContain(ownerUserId);
  });

  it("rejects a snapshot request with no device token or a garbage one", async () => {
    const noToken = await app.inject({ method: "GET", url: "/sync/snapshot" });
    expect(noToken.statusCode).toBe(401);

    const garbage = await app.inject({ method: "GET", url: "/sync/snapshot", headers: { "x-device-token": "not-a-real-token" } });
    expect(garbage.statusCode).toBe(401);
  });

  it("one device's snapshot never contains another restaurant's staff", async () => {
    const a = await createPairedDevice("snap-iso-a");
    const b = await createPairedDevice("snap-iso-b");

    const response = await app.inject({ method: "GET", url: "/sync/snapshot", headers: { "x-device-token": a.deviceToken } });
    const content = JSON.parse(response.json<{ contentJson: string }>().contentJson) as { staff: Array<{ id: string }> };

    expect(content.staff.map((s) => s.id)).not.toContain(b.ownerUserId);
  });

  it("exposes the signing public key with no auth required", async () => {
    const response = await app.inject({ method: "GET", url: "/sync/public-key" });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ publicKeyPem: string }>().publicKeyPem).toContain("BEGIN PUBLIC KEY");
  });
});
