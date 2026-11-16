import { randomUUID } from "node:crypto";
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Pool } from "pg";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE, DEV_JWT_SECRET, PermissionGuard, PermissionsService, signAccessToken, TenantContextGuard } from "@mezbaan/nest-core";
import { AppModule } from "./app.module.js";

/** P2-18: invoice generation, over real HTTP. Device creation isn't an api-pos
 * endpoint (that's api-admin's devices-admin.controller.ts) so device fixtures
 * go straight through DB inserts, same reasoning order-items.e2e.test.ts
 * already applies to its own catalog prerequisites. */
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

async function createClosedOrderWithItem(tenant: Tenant, productId: string): Promise<string> {
  const create = await app.inject({
    method: "POST",
    url: "/orders",
    headers: { authorization: `Bearer ${tenant.accessToken}` },
    payload: { branchId: tenant.branchId, orderType: "takeaway", currency: "PKR" },
  });
  if (create.statusCode !== 201) throw new Error(`fixture: order creation failed: ${create.statusCode} ${create.body}`);
  const orderId = create.json<{ id: string }>().id;

  const addItem = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/items`,
    headers: { authorization: `Bearer ${tenant.accessToken}` },
    payload: { productId },
  });
  if (addItem.statusCode !== 201) throw new Error(`fixture: add item failed: ${addItem.statusCode} ${addItem.body}`);

  const close = await app.inject({ method: "POST", url: `/orders/${orderId}/close`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
  if (close.statusCode !== 201) throw new Error(`fixture: close failed: ${close.statusCode} ${close.body}`);

  return orderId;
}

describe("invoices — generation over HTTP (api-pos, P2-18)", () => {
  it("generates an invoice for a closed order and can fetch it back", async () => {
    const tenant = await createTenant("invoice-e2e-happy");
    const productId = await createPricedProduct(tenant, 10_000n);
    const deviceId = await createDevice(tenant);
    const orderId = await createClosedOrderWithItem(tenant, productId);

    const generate = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/invoice`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { deviceId },
    });
    expect(generate.statusCode).toBe(201);
    const invoice = generate.json<{ documentNumber: string; subtotalMinor: string; totalMinor: string }>();
    expect(invoice.documentNumber).toMatch(/^B\d+-T\d+-\d{6}$/);
    expect(invoice.subtotalMinor).toBe("10000");
    expect(invoice.totalMinor).toBe("10000");

    const fetched = await app.inject({ method: "GET", url: `/orders/${orderId}/invoice`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json<{ documentNumber: string }>().documentNumber).toBe(invoice.documentNumber);
  });

  it("returns null when no invoice has been generated for an order yet", async () => {
    const tenant = await createTenant("invoice-e2e-empty");
    const productId = await createPricedProduct(tenant, 10_000n);
    const orderId = await createClosedOrderWithItem(tenant, productId);

    const fetched = await app.inject({ method: "GET", url: `/orders/${orderId}/invoice`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toBeNull();
  });

  it("rejects generating an invoice for an order that isn't closed", async () => {
    const tenant = await createTenant("invoice-e2e-not-closed");
    const deviceId = await createDevice(tenant);
    const create = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { branchId: tenant.branchId, orderType: "takeaway", currency: "PKR" },
    });
    const orderId = create.json<{ id: string }>().id;

    const generate = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/invoice`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { deviceId },
    });
    expect(generate.statusCode).toBe(400);
  });

  it("rejects a cross-tenant order with a 404, never leaking whether it exists", async () => {
    const tenantA = await createTenant("invoice-e2e-cross-a");
    const tenantB = await createTenant("invoice-e2e-cross-b");
    const productId = await createPricedProduct(tenantA, 10_000n);
    const deviceB = await createDevice(tenantB);
    const orderId = await createClosedOrderWithItem(tenantA, productId);

    const generate = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/invoice`,
      headers: { authorization: `Bearer ${tenantB.accessToken}` },
      payload: { deviceId: deviceB },
    });
    expect(generate.statusCode).toBe(404);
  });
});

async function createClosedOrderWithSeats(tenant: Tenant, productId: string, seats: number[]): Promise<{ orderId: string; itemIds: string[] }> {
  const create = await app.inject({
    method: "POST",
    url: "/orders",
    headers: { authorization: `Bearer ${tenant.accessToken}` },
    payload: { branchId: tenant.branchId, orderType: "takeaway", currency: "PKR" },
  });
  const orderId = create.json<{ id: string }>().id;

  const itemIds: string[] = [];
  for (const seatNumber of seats) {
    const addItem = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/items`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { productId, seatNumber },
    });
    itemIds.push(addItem.json<{ id: string }>().id);
  }

  await app.inject({ method: "POST", url: `/orders/${orderId}/close`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
  return { orderId, itemIds };
}

describe("invoices — splitting by seat and by item over HTTP (api-pos, P2-21)", () => {
  it("splits by seat into one invoice per seat", async () => {
    const tenant = await createTenant("invoice-e2e-split-seat");
    const productId = await createPricedProduct(tenant, 10_000n);
    const deviceId = await createDevice(tenant);
    const { orderId } = await createClosedOrderWithSeats(tenant, productId, [1, 1, 2]);

    const split = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/invoices/split-by-seat`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { deviceId },
    });
    expect(split.statusCode).toBe(201);
    const invoices = split.json<{ subtotalMinor: string }[]>();
    expect(invoices).toHaveLength(2);
    expect(invoices.map((inv) => inv.subtotalMinor).sort()).toEqual(["10000", "20000"]);

    const list = await app.inject({ method: "GET", url: `/orders/${orderId}/invoices`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(list.statusCode).toBe(200);
    expect(list.json<unknown[]>()).toHaveLength(2);
  });

  it("splits by caller-chosen item groups", async () => {
    const tenant = await createTenant("invoice-e2e-split-items");
    const productId = await createPricedProduct(tenant, 10_000n);
    const deviceId = await createDevice(tenant);
    const { orderId, itemIds } = await createClosedOrderWithSeats(tenant, productId, [1, 2, 3]);

    const split = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/invoices/split-by-items`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { deviceId, groups: [[itemIds[0], itemIds[1]], [itemIds[2]]] },
    });
    expect(split.statusCode).toBe(201);
    const invoices = split.json<{ subtotalMinor: string }[]>();
    expect(invoices.map((inv) => inv.subtotalMinor).sort()).toEqual(["10000", "20000"]);
  });

  it("rejects an item id already billed on a prior split invoice", async () => {
    const tenant = await createTenant("invoice-e2e-split-already-billed");
    const productId = await createPricedProduct(tenant, 10_000n);
    const deviceId = await createDevice(tenant);
    const { orderId, itemIds } = await createClosedOrderWithSeats(tenant, productId, [1, 2]);

    await app.inject({
      method: "POST",
      url: `/orders/${orderId}/invoice`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { deviceId, itemIds: [itemIds[0]] },
    });

    const again = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/invoice`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { deviceId, itemIds: [itemIds[0]] },
    });
    expect(again.statusCode).toBe(404);
  });
});
