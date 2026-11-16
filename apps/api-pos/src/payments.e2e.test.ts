import { randomUUID } from "node:crypto";
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Pool } from "pg";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE, DEV_JWT_SECRET, PermissionGuard, PermissionsService, signAccessToken, TenantContextGuard } from "@mezbaan/nest-core";
import { AppModule } from "./app.module.js";

/** P2-19: recording payments against an invoice (P2-18), over real HTTP. Same
 * fixture conventions as invoices.e2e.test.ts — device creation isn't an
 * api-pos endpoint, so it goes straight through a DB insert. */
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
  ownerUserId: string;
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

    return { restaurantId: restaurant.id, branchId: branch.id, ownerUserId: owner.id, accessToken };
  });
}

async function createPricedProduct(tenant: Tenant, unitPriceMinor: bigint): Promise<string> {
  return withTenant(db, { restaurantId: tenant.restaurantId }, async (tx) => {
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

    await tx.insert(schema.priceListItems).values({ restaurantId: tenant.restaurantId, priceListId, productId, unitPriceMinor });
    return productId;
  });
}

async function createDevice(tenant: Tenant): Promise<string> {
  return withTenant(db, { restaurantId: tenant.restaurantId }, async (tx) => {
    const rows = await tx
      .insert(schema.devices)
      .values({ restaurantId: tenant.restaurantId, branchId: tenant.branchId, label: "Till 1", deviceType: "pos_terminal" })
      .returning({ id: schema.devices.id });
    const id = rows[0]?.id;
    if (!id) throw new Error("fixture: device insert returned no row");
    return id;
  });
}

async function createInvoice(tenant: Tenant): Promise<string> {
  const productId = await createPricedProduct(tenant, 10_000n);
  const deviceId = await createDevice(tenant);

  const create = await app.inject({
    method: "POST",
    url: "/orders",
    headers: { authorization: `Bearer ${tenant.accessToken}` },
    payload: { branchId: tenant.branchId, orderType: "takeaway", currency: "PKR" },
  });
  const orderId = create.json<{ id: string }>().id;

  await app.inject({ method: "POST", url: `/orders/${orderId}/items`, headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { productId } });
  await app.inject({ method: "POST", url: `/orders/${orderId}/close`, headers: { authorization: `Bearer ${tenant.accessToken}` } });

  const generate = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/invoice`,
    headers: { authorization: `Bearer ${tenant.accessToken}` },
    payload: { deviceId },
  });
  if (generate.statusCode !== 201) throw new Error(`fixture: invoice generation failed: ${generate.statusCode} ${generate.body}`);
  return generate.json<{ id: string }>().id;
}

describe("payments — recording over HTTP (api-pos, P2-19)", () => {
  it("records a payment with a tip and lists it back", async () => {
    const tenant = await createTenant("payment-e2e-happy");
    const invoiceId = await createInvoice(tenant);

    const record = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/payments`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { method: "cash", amountMinor: "10000", tipMinor: "500" },
    });
    expect(record.statusCode).toBe(201);
    const payment = record.json<{ method: string; amountMinor: string; tipMinor: string }>();
    expect(payment.method).toBe("cash");
    expect(payment.amountMinor).toBe("10000");
    expect(payment.tipMinor).toBe("500");

    const list = await app.inject({ method: "GET", url: `/invoices/${invoiceId}/payments`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(list.statusCode).toBe(200);
    expect(list.json<unknown[]>()).toHaveLength(1);
  });

  it("returns an empty list before any payment has been recorded", async () => {
    const tenant = await createTenant("payment-e2e-empty");
    const invoiceId = await createInvoice(tenant);

    const list = await app.inject({ method: "GET", url: `/invoices/${invoiceId}/payments`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(list.statusCode).toBe(200);
    expect(list.json<unknown[]>()).toEqual([]);
  });

  it("rejects a zero amount", async () => {
    const tenant = await createTenant("payment-e2e-bad-amount");
    const invoiceId = await createInvoice(tenant);

    const record = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/payments`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { method: "cash", amountMinor: "0" },
    });
    expect(record.statusCode).toBe(400);
  });

  it("rejects a cross-tenant invoice with a 404", async () => {
    const tenantA = await createTenant("payment-e2e-cross-a");
    const tenantB = await createTenant("payment-e2e-cross-b");
    const invoiceId = await createInvoice(tenantA);

    const record = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/payments`,
      headers: { authorization: `Bearer ${tenantB.accessToken}` },
      payload: { method: "cash", amountMinor: "10000" },
    });
    expect(record.statusCode).toBe(404);
  });

  it("P2-20: splits an invoice across two methods, with the balance going to zero", async () => {
    const tenant = await createTenant("payment-e2e-split");
    const invoiceId = await createInvoice(tenant);

    const first = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/payments`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { method: "cash", amountMinor: "4000" },
    });
    expect(first.statusCode).toBe(201);

    const balanceAfterFirst = await app.inject({ method: "GET", url: `/invoices/${invoiceId}/balance`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(balanceAfterFirst.json<{ remainingMinor: string }>().remainingMinor).toBe("6000");

    const second = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/payments`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { method: "card", amountMinor: "6000" },
    });
    expect(second.statusCode).toBe(201);

    const balanceAfterSecond = await app.inject({ method: "GET", url: `/invoices/${invoiceId}/balance`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(balanceAfterSecond.json<{ totalMinor: string; remainingMinor: string; paidMinor: string }>()).toEqual({ totalMinor: "10000", remainingMinor: "0", paidMinor: "10000" });
  });

  it("P2-20: a cash payment tendered above the balance returns exact change", async () => {
    const tenant = await createTenant("payment-e2e-change");
    const invoiceId = await createInvoice(tenant);

    const record = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/payments`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { method: "cash", amountMinor: "10000", tenderedMinor: "10500" },
    });
    expect(record.statusCode).toBe(201);
    expect(record.json<{ changeMinor: string }>().changeMinor).toBe("500");
  });

  it("P2-20: rejects a payment that would overpay the invoice", async () => {
    const tenant = await createTenant("payment-e2e-overpay");
    const invoiceId = await createInvoice(tenant);

    await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/payments`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { method: "cash", amountMinor: "6000" },
    });

    const overpay = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/payments`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { method: "card", amountMinor: "5000" },
    });
    expect(overpay.statusCode).toBe(400);
  });

  it("P2-21: suggests an equal split that sums back to the full balance", async () => {
    const tenant = await createTenant("payment-e2e-equal-split");
    const invoiceId = await createInvoice(tenant);

    const split = await app.inject({ method: "GET", url: `/invoices/${invoiceId}/split?parts=3`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(split.statusCode).toBe(200);
    const body = split.json<{ currency: string; amountsMinor: string[] }>();
    expect(body.amountsMinor).toHaveLength(3);
    expect(body.amountsMinor.reduce((total, share) => total + BigInt(share), 0n)).toBe(10_000n);
  });
});
