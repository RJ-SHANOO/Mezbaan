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
  TenantContextGuard,
} from "@mezbaan/nest-core";
import { AppModule } from "./app.module.js";

/**
 * The admin-initiated half of device pairing (create a device, generate a pairing
 * code, revoke it) already has HTTP-level coverage in api-admin's
 * tenant-isolation.e2e.test.ts. This is the terminal-initiated half: redeeming a
 * pairing code and presenting a device token, over real HTTP against the actual
 * api-pos app with the same guards main.ts registers. Fixtures go straight through
 * DeviceService against the DB — there's nothing to gain from re-proving the
 * admin HTTP layer here too.
 */
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

interface Tenant {
  restaurantId: string;
  branchId: string;
  ownerUserId: string;
}

async function createTenant(label: string): Promise<Tenant> {
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

  return withTenant(db, { restaurantId: restaurant.id }, async (tx) => {
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

    return { restaurantId: restaurant.id, branchId: branch.id, ownerUserId: owner.id };
  });
}

async function createPairingCode(label: string): Promise<{ tenant: Tenant; deviceId: string; pairingCode: string }> {
  const tenant = await createTenant(label);
  const device = await deviceService.create({
    restaurantId: tenant.restaurantId,
    actorUserId: tenant.ownerUserId,
    branchId: tenant.branchId,
    label: `${label}-device`,
    deviceType: "pos_terminal",
  });
  const { pairingCode } = await deviceService.generatePairingCode({
    restaurantId: tenant.restaurantId,
    actorUserId: tenant.ownerUserId,
    deviceId: device.id,
  });
  return { tenant, deviceId: device.id, pairingCode };
}

describe("devices — terminal pairing over HTTP (api-pos)", () => {
  it("redeems a pairing code for a working device token, and /devices/me confirms it", async () => {
    const { deviceId, pairingCode } = await createPairingCode("pos-pair-ok");

    const pair = await app.inject({ method: "POST", url: "/devices/pair", payload: { pairingCode } });
    expect(pair.statusCode).toBe(201);
    const { deviceToken, device } = pair.json<{ deviceToken: string; device: { id: string } }>();
    expect(device.id).toBe(deviceId);
    expect(deviceToken).toBeTruthy();

    const me = await app.inject({ method: "GET", url: "/devices/me", headers: { "x-device-token": deviceToken } });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ id: string }>().id).toBe(deviceId);
  });

  it("rejects a missing or garbage pairing code", async () => {
    const noBody = await app.inject({ method: "POST", url: "/devices/pair", payload: {} });
    expect(noBody.statusCode).toBe(400);

    const garbage = await app.inject({ method: "POST", url: "/devices/pair", payload: { pairingCode: "not-a-real-code" } });
    expect(garbage.statusCode).toBe(401);
  });

  it("a pairing code can't be redeemed twice", async () => {
    const { pairingCode } = await createPairingCode("pos-pair-once");

    const first = await app.inject({ method: "POST", url: "/devices/pair", payload: { pairingCode } });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({ method: "POST", url: "/devices/pair", payload: { pairingCode } });
    expect(second.statusCode).toBe(401);
  });

  it("rejects /devices/me with no token and with a garbage token", async () => {
    const noToken = await app.inject({ method: "GET", url: "/devices/me" });
    expect(noToken.statusCode).toBe(401);

    const garbage = await app.inject({ method: "GET", url: "/devices/me", headers: { "x-device-token": "not-a-real-token" } });
    expect(garbage.statusCode).toBe(401);
  });

  it("a revoked device's token is rejected by /devices/me — remote revocation actually takes effect", async () => {
    const { tenant, deviceId, pairingCode } = await createPairingCode("pos-revoked");
    const pair = await app.inject({ method: "POST", url: "/devices/pair", payload: { pairingCode } });
    const { deviceToken } = pair.json<{ deviceToken: string }>();

    await deviceService.revoke({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, deviceId });

    const revoked = await app.inject({ method: "GET", url: "/devices/me", headers: { "x-device-token": deviceToken } });
    expect(revoked.statusCode).toBe(401);
  });
});
