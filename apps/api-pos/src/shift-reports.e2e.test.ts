import { randomUUID } from "node:crypto";
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Pool } from "pg";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE, DEV_JWT_SECRET, PermissionGuard, PermissionsService, signAccessToken, TenantContextGuard } from "@mezbaan/nest-core";
import { AppModule } from "./app.module.js";

/** P2-29: X report (mid-shift) and Z report (end-of-shift, over/short). */
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

async function openShiftAndRingUpCashSale(tenant: Tenant): Promise<string> {
  const open = await app.inject({ method: "POST", url: "/shifts", headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { deviceId: tenant.deviceId, openingFloatMinor: "5000", currency: "PKR" } });
  const shiftId = open.json<{ id: string }>().id;

  const { productId } = await withTenant(db, { restaurantId: tenant.restaurantId }, async (tx) => {
    const categoryRows = await tx.insert(schema.categories).values({ restaurantId: tenant.restaurantId, name: "Burgers" }).returning({ id: schema.categories.id });
    const categoryId = categoryRows[0]?.id;
    if (!categoryId) throw new Error("fixture: category insert returned no row");
    const productRows = await tx.insert(schema.products).values({ restaurantId: tenant.restaurantId, categoryId, name: "Cheeseburger" }).returning({ id: schema.products.id });
    const productId = productRows[0]?.id;
    if (!productId) throw new Error("fixture: product insert returned no row");
    const priceListRows = await tx
      .insert(schema.priceLists)
      .values({ restaurantId: tenant.restaurantId, name: `List-${randomUUID()}`, currency: "PKR", status: "published" })
      .returning({ id: schema.priceLists.id });
    const priceListId = priceListRows[0]?.id;
    if (!priceListId) throw new Error("fixture: price list insert returned no row");
    await tx.insert(schema.priceListItems).values({ restaurantId: tenant.restaurantId, priceListId, productId, unitPriceMinor: 10_000n });
    return { productId };
  });

  const order = await app.inject({ method: "POST", url: "/orders", headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { branchId: tenant.branchId, orderType: "takeaway", currency: "PKR" } });
  const orderId = order.json<{ id: string }>().id;
  await app.inject({ method: "POST", url: `/orders/${orderId}/items`, headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { productId } });
  await app.inject({ method: "POST", url: `/orders/${orderId}/close`, headers: { authorization: `Bearer ${tenant.accessToken}` } });

  const invoiceResult = await app.inject({ method: "POST", url: `/orders/${orderId}/invoice`, headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { deviceId: tenant.deviceId } });
  const invoice = invoiceResult.json<{ id: string; totalMinor: string }>();
  await app.inject({ method: "POST", url: `/invoices/${invoice.id}/payments`, headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { method: "cash", amountMinor: invoice.totalMinor } });

  return shiftId;
}

describe("shift X/Z reports with over/short (api-pos, P2-29)", () => {
  it("the X report shows expected cash mid-shift", async () => {
    const tenant = await createTenant("shift-report-e2e-x");
    const shiftId = await openShiftAndRingUpCashSale(tenant);

    const x = await app.inject({ method: "GET", url: `/shifts/${shiftId}/x-report`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(x.statusCode).toBe(200);
    expect(x.json<{ expectedCashMinor: string }>().expectedCashMinor).toBe("15000");
  });

  it("the Z report shows over/short once the shift is closed", async () => {
    const tenant = await createTenant("shift-report-e2e-z");
    const shiftId = await openShiftAndRingUpCashSale(tenant);

    const beforeClose = await app.inject({ method: "GET", url: `/shifts/${shiftId}/z-report`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(beforeClose.statusCode).toBe(400);

    await app.inject({
      method: "POST",
      url: `/shifts/${shiftId}/close`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { denominationCounts: [{ denominationMinor: "14000", count: 1 }] },
    });

    const z = await app.inject({ method: "GET", url: `/shifts/${shiftId}/z-report`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(z.statusCode).toBe(200);
    expect(z.json<{ overShortMinor: string }>().overShortMinor).toBe("-1000");
  });
});
