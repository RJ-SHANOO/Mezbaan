import { randomUUID } from "node:crypto";
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Pool } from "pg";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE, DEV_JWT_SECRET, PermissionGuard, PermissionsService, signAccessToken, TenantContextGuard } from "@mezbaan/nest-core";
import { AppModule } from "./app.module.js";

/** P2-40: basic pilot reports, over real HTTP — proves the route wiring,
 * the reports.view permission gate, and JSON serialization, on top of
 * sales-reports.service.test.ts's much more thorough aggregation-math
 * coverage. */
const SECRET = process.env.JWT_SECRET ?? DEV_JWT_SECRET;
const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5432/mezbaan";

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
    const branchRows = await tx.insert(schema.branches).values({ restaurantId: restaurant.id, name: "Main", timezone: "Asia/Karachi" }).returning({ id: schema.branches.id });
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

describe("sales reports (api-reports, P2-40)", () => {
  it("returns a zeroed daily summary for a day with no activity", async () => {
    const tenant = await createTenant("report-e2e-empty");

    const response = await app.inject({
      method: "GET",
      url: `/reports/daily-summary?branchId=${tenant.branchId}&businessDate=2026-01-01`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ orderCount: 0, grossSalesMinor: "0" });
  });

  it("rejects an unauthenticated request", async () => {
    const tenant = await createTenant("report-e2e-no-auth");
    const response = await app.inject({ method: "GET", url: `/reports/daily-summary?branchId=${tenant.branchId}&businessDate=2026-01-01` });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a malformed businessDate", async () => {
    const tenant = await createTenant("report-e2e-bad-date");
    const response = await app.inject({
      method: "GET",
      url: `/reports/daily-summary?branchId=${tenant.branchId}&businessDate=not-a-date`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
    });
    expect(response.statusCode).toBe(400);
  });

  it("returns empty void/discount/refund reports for a quiet day, with correct shape", async () => {
    const tenant = await createTenant("report-e2e-shapes");

    const voids = await app.inject({ method: "GET", url: `/reports/voids?branchId=${tenant.branchId}&businessDate=2026-01-01`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(voids.statusCode).toBe(200);
    expect(voids.json()).toMatchObject({ entries: [], totalValueMinor: "0" });

    const discounts = await app.inject({ method: "GET", url: `/reports/discounts?branchId=${tenant.branchId}&businessDate=2026-01-01`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(discounts.statusCode).toBe(200);
    expect(discounts.json()).toMatchObject({ entries: [], totalDiscountMinor: "0" });

    const refunds = await app.inject({ method: "GET", url: `/reports/refunds?branchId=${tenant.branchId}&businessDate=2026-01-01`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(refunds.statusCode).toBe(200);
    expect(refunds.json()).toMatchObject({ entries: [], totalRefundedMinor: "0" });

    const payments = await app.inject({ method: "GET", url: `/reports/payment-breakdown?branchId=${tenant.branchId}&businessDate=2026-01-01`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(payments.statusCode).toBe(200);
    expect(payments.json()).toMatchObject({ byMethod: { cash: "0", card: "0", bank_transfer: "0", wallet: "0" }, totalMinor: "0" });
  });
});
