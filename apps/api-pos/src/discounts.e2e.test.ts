import { randomUUID } from "node:crypto";
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Pool } from "pg";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE, DEV_JWT_SECRET, PermissionGuard, PermissionsService, signAccessToken, TenantContextGuard } from "@mezbaan/nest-core";
import { AppModule } from "./app.module.js";

/** P2-22: bill-level and item-level discounts, including the manager-PIN
 * escalation above the own-authority limit — the first real exercise of
 * ManagerPinService (P1-13) end to end. Depends on seed.ts's
 * pos.discount.approve grant to branch_manager actually being in the test
 * database (same assumption every other permission-gated e2e test here
 * already makes for pos.sell) — rerun the seed if this permission was added
 * after the local dev DB was last seeded. */
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

async function setLoyaltyReasonCode(tenant: Tenant): Promise<void> {
  const set = await app.inject({
    method: "PUT",
    url: "/discount-reason-codes",
    headers: { authorization: `Bearer ${tenant.accessToken}` },
    payload: { code: "loyalty", label: "Loyalty discount" },
  });
  if (set.statusCode !== 200) throw new Error(`fixture: set reason code failed: ${set.statusCode} ${set.body}`);
}

async function setLimits(tenant: Tenant, body: Record<string, unknown>): Promise<void> {
  const set = await app.inject({ method: "PUT", url: "/discount-limits", headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: body });
  if (set.statusCode !== 200) throw new Error(`fixture: set limits failed: ${set.statusCode} ${set.body}`);
}

/** api-pos has no catalog endpoints — fixtures go straight through DB, same convention as the other api-pos e2e tests. */
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

describe("discounts — item and bill level, with manager approval (api-pos, P2-22)", () => {
  it("applies an item discount within the cashier's own authority, no approval needed", async () => {
    const tenant = await createTenant("discount-e2e-item-ok");
    await setLoyaltyReasonCode(tenant);
    await setLimits(tenant, { maxUnapprovedPercentBasisPoints: 2000 });
    const { orderId, itemId } = await createOpenOrderWithItem(tenant);

    const apply = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/items/${itemId}/discount`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { percentBasisPoints: 1000, reasonCode: "loyalty" },
    });
    expect(apply.statusCode).toBe(201);
    const outcome = apply.json<{ discountMinor: string; approvedByUserId: string | null }>();
    expect(outcome.discountMinor).toBe("1000");
    expect(outcome.approvedByUserId).toBeNull();
  });

  it("rejects a discount above the limit without a manager PIN, then accepts it with one", async () => {
    const tenant = await createTenant("discount-e2e-item-approval");
    await setLoyaltyReasonCode(tenant);
    await setLimits(tenant, { maxUnapprovedPercentBasisPoints: 1000 });
    const managerId = await createManagerWithPin(tenant, "discount-e2e-manager", "4321");
    const { orderId, itemId } = await createOpenOrderWithItem(tenant);

    const withoutApproval = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/items/${itemId}/discount`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { percentBasisPoints: 5000, reasonCode: "loyalty" },
    });
    expect(withoutApproval.statusCode).toBe(400);

    const withApproval = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/items/${itemId}/discount`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { percentBasisPoints: 5000, reasonCode: "loyalty", managerUserId: managerId, managerPin: "4321" },
    });
    expect(withApproval.statusCode).toBe(201);
    expect(withApproval.json<{ approvedByUserId: string }>().approvedByUserId).toBe(managerId);
  });

  it("applies and removes a bill-level discount", async () => {
    const tenant = await createTenant("discount-e2e-bill");
    await setLoyaltyReasonCode(tenant);
    await setLimits(tenant, { maxUnapprovedAmountMinor: "5000" });
    const { orderId } = await createOpenOrderWithItem(tenant);

    const apply = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/discount`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { amountMinor: "1000", reasonCode: "loyalty" },
    });
    expect(apply.statusCode).toBe(201);

    const remove = await app.inject({ method: "DELETE", url: `/orders/${orderId}/discount`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(remove.statusCode).toBe(200);
  });
});
