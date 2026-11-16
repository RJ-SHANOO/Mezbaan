import { randomUUID } from "node:crypto";
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Pool } from "pg";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE, DEV_JWT_SECRET, PermissionGuard, PermissionsService, signAccessToken, TenantContextGuard } from "@mezbaan/nest-core";
import { AppModule } from "./app.module.js";

/** P2-28: cash in/out with reason codes, plus the automatic and manual
 * drawer-open log, against an open shift (P2-27). */
const SECRET = process.env.JWT_SECRET ?? DEV_JWT_SECRET;
const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let app: NestFastifyApplication;
let pool: Pool;
let db: Database;

beforeAll(async () => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);

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
  deviceId: string;
  accessToken: string;
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

    const deviceRows = await tx
      .insert(schema.devices)
      .values({ restaurantId: restaurant.id, branchId: branch.id, label: "Till 1", deviceType: "pos_terminal" })
      .returning({ id: schema.devices.id });
    const device = deviceRows[0];
    if (!device) throw new Error("fixture: device insert returned no row");

    const accessToken = signAccessToken(
      { sub: owner.id, restaurantId: restaurant.id, isSuperAdmin: false, roleKey: "owner", branchId: branch.id },
      { secret: SECRET, expiresInSeconds: 3600 },
    );

    return { restaurantId: restaurant.id, branchId: branch.id, deviceId: device.id, accessToken };
  });
}

async function openShift(tenant: Tenant): Promise<string> {
  const open = await app.inject({ method: "POST", url: "/shifts", headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { deviceId: tenant.deviceId, openingFloatMinor: "5000", currency: "PKR" } });
  return open.json<{ id: string }>().id;
}

async function setPettyCashReasonCode(tenant: Tenant): Promise<void> {
  const set = await app.inject({ method: "PUT", url: "/cash-movement-reason-codes", headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { code: "petty_cash", label: "Petty cash payout" } });
  if (set.statusCode !== 200) throw new Error(`fixture: set reason code failed: ${set.statusCode} ${set.body}`);
}

describe("cash in/out and drawer-open logging (api-pos, P2-28)", () => {
  it("records a cash-in, then a cash-out, and both drawer-open events", async () => {
    const tenant = await createTenant("cash-e2e-ok");
    await setPettyCashReasonCode(tenant);
    const shiftId = await openShift(tenant);

    const cashIn = await app.inject({ method: "POST", url: `/shifts/${shiftId}/cash-in`, headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { amountMinor: "2000", reasonCode: "petty_cash" } });
    expect(cashIn.statusCode).toBe(201);

    const cashOut = await app.inject({ method: "POST", url: `/shifts/${shiftId}/cash-out`, headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { amountMinor: "500", reasonCode: "petty_cash" } });
    expect(cashOut.statusCode).toBe(201);

    const drawerOpens = await app.inject({ method: "GET", url: `/shifts/${shiftId}/drawer-opens`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(drawerOpens.json<{ trigger: string }[]>().map((e) => e.trigger).sort()).toEqual(["cash_in", "cash_out"]);
  });

  it("logs a manual no-sale drawer open", async () => {
    const tenant = await createTenant("cash-e2e-no-sale");
    const shiftId = await openShift(tenant);

    const open = await app.inject({ method: "POST", url: `/shifts/${shiftId}/drawer-open`, headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { trigger: "no_sale" } });
    expect(open.statusCode).toBe(201);
    expect(open.json<{ trigger: string }>().trigger).toBe("no_sale");
  });

  it("rejects a cash movement with an unknown reason code", async () => {
    const tenant = await createTenant("cash-e2e-bad-reason");
    const shiftId = await openShift(tenant);

    const cashIn = await app.inject({ method: "POST", url: `/shifts/${shiftId}/cash-in`, headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { amountMinor: "1000", reasonCode: "nonexistent" } });
    expect(cashIn.statusCode).toBe(400);
  });
});
