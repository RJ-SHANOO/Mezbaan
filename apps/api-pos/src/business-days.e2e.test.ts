import { randomUUID } from "node:crypto";
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Pool } from "pg";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE, DEV_JWT_SECRET, PermissionGuard, PermissionsService, signAccessToken, TenantContextGuard } from "@mezbaan/nest-core";
import { AppModule } from "./app.module.js";

/** P2-30: closing a branch's business day blocks new /orders POSTs for that
 * branch. asOfBusinessDate (the "don't lose an offline sale" override) is
 * deliberately NOT exposed on this public endpoint — only a future trusted
 * sync-replay path calling OrdersService.create directly could use it — so
 * there's nothing to exercise over HTTP for that half; see
 * business-days.service.test.ts for that case. */
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

    const accessToken = signAccessToken(
      { sub: owner.id, restaurantId: restaurant.id, isSuperAdmin: false, roleKey: "owner", branchId: branch.id },
      { secret: SECRET, expiresInSeconds: 3600 },
    );

    return { restaurantId: restaurant.id, branchId: branch.id, accessToken };
  });
}

describe("business-day close blocks new sales (api-pos, P2-30)", () => {
  it("allows an order before the day is closed, then blocks a new one after", async () => {
    const tenant = await createTenant("bizday-e2e-blocks");

    const before = await app.inject({ method: "POST", url: "/orders", headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { branchId: tenant.branchId, orderType: "takeaway", currency: "PKR" } });
    expect(before.statusCode).toBe(201);

    const close = await app.inject({ method: "POST", url: "/business-days/close", headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { branchId: tenant.branchId } });
    expect(close.statusCode).toBe(201);
    expect(close.json<{ status: string }>().status).toBe("closed");

    const after = await app.inject({ method: "POST", url: "/orders", headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { branchId: tenant.branchId, orderType: "takeaway", currency: "PKR" } });
    expect(after.statusCode).toBe(400);
  });

  it("rejects closing an already-closed day, and GET status reflects it", async () => {
    const tenant = await createTenant("bizday-e2e-status");
    await app.inject({ method: "POST", url: "/business-days/close", headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { branchId: tenant.branchId } });

    const second = await app.inject({ method: "POST", url: "/business-days/close", headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { branchId: tenant.branchId } });
    expect(second.statusCode).toBe(400);

    const status = await app.inject({ method: "GET", url: `/business-days/status?branchId=${tenant.branchId}`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(status.json<{ status: string }>().status).toBe("closed");
  });
});
