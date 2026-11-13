import { randomUUID } from "node:crypto";
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Pool } from "pg";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE, DEV_JWT_SECRET, PermissionGuard, PermissionsService, signAccessToken, TenantContextGuard } from "@mezbaan/nest-core";
import { AppModule } from "./app.module.js";

/** P2-12: the cart. Catalog management (categories/products/price lists) lives in
 * api-admin, which this process doesn't mount — so priced-product fixtures go
 * straight through DB inserts, same as orders.e2e.test.ts/delivery.e2e.test.ts
 * do for their own prerequisites. Only the order-items endpoints themselves
 * (mounted here, in api-pos) go through real HTTP. */
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

async function attachModifierGroup(
  tenant: Tenant,
  productId: string,
  params: { minSelections?: number; maxSelections?: number | null; optionPriceMinor?: bigint },
): Promise<{ priced: string; free: string }> {
  return withTenant(db, { restaurantId: tenant.restaurantId }, async (tx) => {
    const groupRows = await tx
      .insert(schema.modifierGroups)
      .values({ restaurantId: tenant.restaurantId, name: "Toppings", minSelections: params.minSelections ?? 0, maxSelections: params.maxSelections ?? null })
      .returning({ id: schema.modifierGroups.id });
    const groupId = groupRows[0]?.id;
    if (!groupId) throw new Error("fixture: modifier group insert returned no row");

    const optionRows = await tx
      .insert(schema.modifierOptions)
      .values([
        { restaurantId: tenant.restaurantId, modifierGroupId: groupId, name: "Extra Cheese" },
        { restaurantId: tenant.restaurantId, modifierGroupId: groupId, name: "Bacon" },
      ])
      .returning({ id: schema.modifierOptions.id });
    const priced = optionRows[0]?.id;
    const free = optionRows[1]?.id;
    if (!priced || !free) throw new Error("fixture: modifier option insert returned too few rows");

    await tx.insert(schema.productModifierGroups).values({ restaurantId: tenant.restaurantId, productId, modifierGroupId: groupId });

    if (params.optionPriceMinor !== undefined) {
      const priceListRows = await tx
        .insert(schema.priceLists)
        .values({ restaurantId: tenant.restaurantId, name: `ModList-${randomUUID()}`, currency: "PKR", status: "published" })
        .returning({ id: schema.priceLists.id });
      const priceListId = priceListRows[0]?.id;
      if (!priceListId) throw new Error("fixture: price list insert returned no row");
      await tx.insert(schema.priceListItems).values({ restaurantId: tenant.restaurantId, priceListId, modifierOptionId: priced, unitPriceMinor: params.optionPriceMinor });
    }

    return { priced, free };
  });
}

async function createOpenOrder(tenant: Tenant): Promise<string> {
  const create = await app.inject({
    method: "POST",
    url: "/orders",
    headers: { authorization: `Bearer ${tenant.accessToken}` },
    payload: { branchId: tenant.branchId, orderType: "takeaway", currency: "PKR" },
  });
  if (create.statusCode !== 201) throw new Error(`fixture: order creation failed: ${create.statusCode} ${create.body}`);
  return create.json<{ id: string }>().id;
}

describe("order items — the cart (api-pos, P2-12)", () => {
  it("adds, lists, updates and removes an item (positive control)", async () => {
    const tenant = await createTenant("item-ok");
    const productId = await createPricedProduct(tenant, 1500n);
    const orderId = await createOpenOrder(tenant);

    const add = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/items`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { productId, quantity: 2, notes: "No onions" },
    });
    expect(add.statusCode).toBe(201);
    const item = add.json<{ id: string; unitPriceMinor: string; quantity: number; notes: string | null }>();
    expect(item.unitPriceMinor).toBe("1500");
    expect(item.quantity).toBe(2);
    expect(item.notes).toBe("No onions");

    const list = await app.inject({ method: "GET", url: `/orders/${orderId}/items`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(list.statusCode).toBe(200);
    expect(list.json<Array<{ id: string }>>().map((i) => i.id)).toEqual([item.id]);

    const update = await app.inject({
      method: "PATCH",
      url: `/orders/${orderId}/items/${item.id}`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { quantity: 3, seatNumber: 2 },
    });
    expect(update.statusCode).toBe(200);
    const updated = update.json<{ quantity: number; seatNumber: number | null }>();
    expect(updated.quantity).toBe(3);
    expect(updated.seatNumber).toBe(2);

    const remove = await app.inject({ method: "DELETE", url: `/orders/${orderId}/items/${item.id}`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(remove.statusCode).toBe(200);

    const listAfterRemove = await app.inject({ method: "GET", url: `/orders/${orderId}/items`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(listAfterRemove.json<unknown[]>()).toEqual([]);
  });

  it("rejects adding an unpriced product", async () => {
    const tenant = await createTenant("item-unpriced");
    const orderId = await createOpenOrder(tenant);
    const productId = await withTenant(db, { restaurantId: tenant.restaurantId }, async (tx) => {
      const categoryRows = await tx.insert(schema.categories).values({ restaurantId: tenant.restaurantId, name: "Burgers" }).returning({ id: schema.categories.id });
      const categoryId = categoryRows[0]!.id;
      const productRows = await tx.insert(schema.products).values({ restaurantId: tenant.restaurantId, categoryId, name: "Unpriced" }).returning({ id: schema.products.id });
      return productRows[0]!.id;
    });

    const add = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/items`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { productId },
    });
    expect(add.statusCode).toBe(400);
  });

  it("adds an item with a priced modifier selection, and defaults an unselected-elsewhere free option to zero", async () => {
    const tenant = await createTenant("item-modifiers");
    const productId = await createPricedProduct(tenant, 1500n);
    const { priced } = await attachModifierGroup(tenant, productId, { optionPriceMinor: 150n });
    const orderId = await createOpenOrder(tenant);

    const add = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/items`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { productId, modifierOptionIds: [priced] },
    });
    expect(add.statusCode).toBe(201);
    const item = add.json<{ modifiers: Array<{ modifierOptionId: string; unitPriceMinor: string }> }>();
    expect(item.modifiers).toHaveLength(1);
    expect(item.modifiers[0]?.unitPriceMinor).toBe("150");
  });

  it("enforces a modifier group's min/max selections", async () => {
    const tenant = await createTenant("item-minmax");
    const productId = await createPricedProduct(tenant, 1500n);
    const { priced, free } = await attachModifierGroup(tenant, productId, { minSelections: 1, maxSelections: 1 });
    const orderId = await createOpenOrder(tenant);

    const tooFew = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/items`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { productId, modifierOptionIds: [] },
    });
    expect(tooFew.statusCode).toBe(400);

    const tooMany = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/items`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { productId, modifierOptionIds: [priced, free] },
    });
    expect(tooMany.statusCode).toBe(400);

    const justRight = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/items`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { productId, modifierOptionIds: [priced] },
    });
    expect(justRight.statusCode).toBe(201);
  });

  it("rejects mutating items once the order is closed", async () => {
    const tenant = await createTenant("item-closed");
    const productId = await createPricedProduct(tenant, 1500n);
    const orderId = await createOpenOrder(tenant);
    const add = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/items`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { productId },
    });
    const itemId = add.json<{ id: string }>().id;

    const close = await app.inject({ method: "POST", url: `/orders/${orderId}/close`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(close.statusCode).toBe(201);

    const addAfterClose = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/items`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { productId },
    });
    expect(addAfterClose.statusCode).toBe(400);

    const updateAfterClose = await app.inject({
      method: "PATCH",
      url: `/orders/${orderId}/items/${itemId}`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { quantity: 2 },
    });
    expect(updateAfterClose.statusCode).toBe(400);
  });

  it("one restaurant's token can never see or mutate another restaurant's order items", async () => {
    const tenantA = await createTenant("item-iso-a");
    const tenantB = await createTenant("item-iso-b");
    const productId = await createPricedProduct(tenantA, 1500n);
    const orderId = await createOpenOrder(tenantA);
    const add = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/items`,
      headers: { authorization: `Bearer ${tenantA.accessToken}` },
      payload: { productId },
    });
    const itemId = add.json<{ id: string }>().id;

    const listByB = await app.inject({ method: "GET", url: `/orders/${orderId}/items`, headers: { authorization: `Bearer ${tenantB.accessToken}` } });
    expect(listByB.json<unknown[]>()).toEqual([]);

    // The order itself isn't visible to tenant B under RLS, so this 404s as
    // "order not found" before ever reaching the item.
    const updateByB = await app.inject({
      method: "PATCH",
      url: `/orders/${orderId}/items/${itemId}`,
      headers: { authorization: `Bearer ${tenantB.accessToken}` },
      payload: { quantity: 2 },
    });
    expect(updateByB.statusCode).toBe(404);
  });
});
