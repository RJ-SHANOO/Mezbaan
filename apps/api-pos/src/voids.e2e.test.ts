import { randomUUID } from "node:crypto";
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Pool } from "pg";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE, DEV_JWT_SECRET, PermissionGuard, PermissionsService, signAccessToken, TenantContextGuard } from "@mezbaan/nest-core";
import { AppModule } from "./app.module.js";

/** P2-23: voiding an order item before or after it's fired to the kitchen,
 * including the manager-PIN escalation once it's been fired — same shape as
 * discounts.e2e.test.ts (P2-22). Depends on seed.ts's pos.void.approve grant
 * to branch_manager actually being in the test database — this one was
 * already present in seed.ts before this feature existed, so no reseed
 * should be needed (unlike pos.discount.approve). */
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

/** Signs in as a branch_manager and sets their own PIN via the real /manager-pin endpoint. */
async function createManagerWithPin(tenant: Tenant, label: string, pin: string): Promise<string> {
  const roleRows = await db
    .insert(schema.roles)
    .values({ key: "branch_manager", name: "Branch Manager" })
    .onConflictDoUpdate({ target: schema.roles.key, set: { name: "Branch Manager" } })
    .returning({ id: schema.roles.id });
  const roleId = roleRows[0]?.id;
  if (!roleId) throw new Error("fixture: role insert returned no row");

  const managerRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) =>
    tx
      .insert(schema.users)
      .values({ restaurantId: tenant.restaurantId, roleId, email: `${label}@example.test`, passwordHash: "unused", displayName: label })
      .returning({ id: schema.users.id }),
  );
  const manager = managerRows[0];
  if (!manager) throw new Error("fixture: manager insert returned no row");

  const managerAccessToken = signAccessToken(
    { sub: manager.id, restaurantId: tenant.restaurantId, isSuperAdmin: false, roleKey: "branch_manager", branchId: tenant.branchId },
    { secret: SECRET, expiresInSeconds: 3600 },
  );
  const setPin = await app.inject({ method: "POST", url: "/manager-pin", headers: { authorization: `Bearer ${managerAccessToken}` }, payload: { pin } });
  if (setPin.statusCode !== 201) throw new Error(`fixture: set manager pin failed: ${setPin.statusCode} ${setPin.body}`);

  return manager.id;
}

async function setMistakeReasonCode(tenant: Tenant): Promise<void> {
  const set = await app.inject({
    method: "PUT",
    url: "/void-reason-codes",
    headers: { authorization: `Bearer ${tenant.accessToken}` },
    payload: { code: "mistake", label: "Order entry mistake" },
  });
  if (set.statusCode !== 200) throw new Error(`fixture: set reason code failed: ${set.statusCode} ${set.body}`);
}

/** api-pos has no catalog endpoints — fixtures go straight through DB, same convention as discounts.e2e.test.ts. */
async function createOpenOrderWithItem(tenant: Tenant): Promise<{ orderId: string; itemId: string }> {
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
    await tx.insert(schema.priceListItems).values({ restaurantId: tenant.restaurantId, priceListId, productId, unitPriceMinor: 10_000n });

    const orderRows = await tx
      .insert(schema.orders)
      .values({ restaurantId: tenant.restaurantId, branchId: tenant.branchId, orderType: "takeaway", currency: "PKR", openedByUserId: tenant.ownerUserId })
      .returning({ id: schema.orders.id });
    const orderId = orderRows[0]?.id;
    if (!orderId) throw new Error("fixture: order insert returned no row");

    const itemRows = await tx
      .insert(schema.orderItems)
      .values({ restaurantId: tenant.restaurantId, orderId, productId, quantity: 1, unitPriceMinor: 10_000n, currency: "PKR", priceListId, priceListVersion: 1 })
      .returning({ id: schema.orderItems.id });
    const itemId = itemRows[0]?.id;
    if (!itemId) throw new Error("fixture: order item insert returned no row");

    return { orderId, itemId };
  });
}

describe("voids — before and after kitchen firing, with manager approval (api-pos, P2-23)", () => {
  it("voids an unfired item with no approval needed", async () => {
    const tenant = await createTenant("void-e2e-unfired-ok");
    await setMistakeReasonCode(tenant);
    const { orderId, itemId } = await createOpenOrderWithItem(tenant);

    const voidResult = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/items/${itemId}/void`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { reasonCode: "mistake" },
    });
    expect(voidResult.statusCode).toBe(201);
    const outcome = voidResult.json<{ requiredApproval: boolean; approvedByUserId: string | null }>();
    expect(outcome.requiredApproval).toBe(false);
    expect(outcome.approvedByUserId).toBeNull();
  });

  it("rejects voiding a fired item without a manager PIN, then accepts it with one", async () => {
    const tenant = await createTenant("void-e2e-fired-approval");
    await setMistakeReasonCode(tenant);
    const managerId = await createManagerWithPin(tenant, "void-e2e-manager", "4321");
    const { orderId, itemId } = await createOpenOrderWithItem(tenant);

    const fire = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/items/fire`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { itemIds: [itemId] },
    });
    expect(fire.statusCode).toBe(201);

    const withoutApproval = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/items/${itemId}/void`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { reasonCode: "mistake" },
    });
    expect(withoutApproval.statusCode).toBe(400);

    const withApproval = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/items/${itemId}/void`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { reasonCode: "mistake", managerUserId: managerId, managerPin: "4321" },
    });
    expect(withApproval.statusCode).toBe(201);
    expect(withApproval.json<{ approvedByUserId: string }>().approvedByUserId).toBe(managerId);
  });

  it("rejects voiding an already-voided item", async () => {
    const tenant = await createTenant("void-e2e-already-voided");
    await setMistakeReasonCode(tenant);
    const { orderId, itemId } = await createOpenOrderWithItem(tenant);

    const first = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/items/${itemId}/void`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { reasonCode: "mistake" },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/items/${itemId}/void`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { reasonCode: "mistake" },
    });
    expect(second.statusCode).toBe(400);
  });
});
