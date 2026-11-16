import { randomUUID } from "node:crypto";
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Pool } from "pg";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE, DEV_JWT_SECRET, PermissionGuard, PermissionsService, signAccessToken, TenantContextGuard } from "@mezbaan/nest-core";
import { AppModule } from "./app.module.js";

/** P2-27: shift open/close with opening float and a denomination-counted
 * close — gated by pos.sell, same tier as any other POS action. */
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

describe("shifts — open and close with denomination counts (api-pos, P2-27)", () => {
  it("opens a shift, then closes it with a counted cash total", async () => {
    const tenant = await createTenant("shift-e2e-ok");

    const open = await app.inject({
      method: "POST",
      url: "/shifts",
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { deviceId: tenant.deviceId, openingFloatMinor: "5000", currency: "PKR" },
    });
    expect(open.statusCode).toBe(201);
    const shift = open.json<{ id: string; status: string }>();
    expect(shift.status).toBe("open");

    const close = await app.inject({
      method: "POST",
      url: `/shifts/${shift.id}/close`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { denominationCounts: [{ denominationMinor: "1000", count: 5 }, { denominationMinor: "500", count: 10 }] },
    });
    expect(close.statusCode).toBe(201);
    expect(close.json<{ status: string; countedCashMinor: string }>()).toMatchObject({ status: "closed", countedCashMinor: "10000" });
  });

  it("rejects opening a second shift on the same till while one is already open", async () => {
    const tenant = await createTenant("shift-e2e-twice");
    await app.inject({ method: "POST", url: "/shifts", headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { deviceId: tenant.deviceId, openingFloatMinor: "5000", currency: "PKR" } });

    const second = await app.inject({ method: "POST", url: "/shifts", headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { deviceId: tenant.deviceId, openingFloatMinor: "1000", currency: "PKR" } });
    expect(second.statusCode).toBe(400);
  });
});
