import { randomUUID } from "node:crypto";
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Pool } from "pg";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE, DEV_JWT_SECRET, PermissionGuard, PermissionsService, signAccessToken, TenantContextGuard } from "@mezbaan/nest-core";
import { AppModule } from "./app.module.js";

/** P2-24: full and partial refunds against a paid invoice, always requiring
 * manager-PIN approval — same shape as discounts/voids.e2e.test.ts. Depends
 * on seed.ts's billing.refund.approve grant to branch_manager (added this
 * task; the permission itself existed from P1-13/early seed.ts, but wasn't
 * granted to branch_manager until now) actually being in the test database. */
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
    url: "/refund-reason-codes",
    headers: { authorization: `Bearer ${tenant.accessToken}` },
    payload: { code: "mistake", label: "Order entry mistake" },
  });
  if (set.statusCode !== 200) throw new Error(`fixture: set reason code failed: ${set.statusCode} ${set.body}`);
}

/** api-pos has no catalog endpoints — fixture goes straight through DB for catalog/pricing, same convention as discounts/voids.e2e.test.ts, then a real closed order billed and paid through HTTP. */
async function createPaidInvoice(tenant: Tenant): Promise<string> {
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
  const closeResult = await app.inject({ method: "POST", url: `/orders/${orderId}/close`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
  if (closeResult.statusCode !== 201 && closeResult.statusCode !== 200) throw new Error(`fixture: close order failed: ${closeResult.statusCode} ${closeResult.body}`);

  const deviceRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) =>
    tx.insert(schema.devices).values({ restaurantId: tenant.restaurantId, branchId: tenant.branchId, label: "Till 1", deviceType: "pos_terminal" }).returning({ id: schema.devices.id }),
  );
  const deviceId = deviceRows[0]?.id;
  if (!deviceId) throw new Error("fixture: device insert returned no row");

  const invoiceResult = await app.inject({ method: "POST", url: `/orders/${orderId}/invoice`, headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { deviceId } });
  if (invoiceResult.statusCode !== 201) throw new Error(`fixture: generate invoice failed: ${invoiceResult.statusCode} ${invoiceResult.body}`);
  const invoice = invoiceResult.json<{ id: string; totalMinor: string }>();

  const paymentResult = await app.inject({
    method: "POST",
    url: `/invoices/${invoice.id}/payments`,
    headers: { authorization: `Bearer ${tenant.accessToken}` },
    payload: { method: "cash", amountMinor: invoice.totalMinor },
  });
  if (paymentResult.statusCode !== 201) throw new Error(`fixture: record payment failed: ${paymentResult.statusCode} ${paymentResult.body}`);

  return invoice.id;
}

describe("refunds — full and partial, always with manager approval (api-pos, P2-24)", () => {
  it("issues a full refund with a manager PIN, reducing the refundable balance to zero", async () => {
    const tenant = await createTenant("refund-e2e-full");
    await setMistakeReasonCode(tenant);
    const managerId = await createManagerWithPin(tenant, "refund-e2e-manager", "4321");
    const invoiceId = await createPaidInvoice(tenant);

    const issue = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/refunds`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { amountMinor: "10000", reasonCode: "mistake", managerUserId: managerId, managerPin: "4321" },
    });
    expect(issue.statusCode).toBe(201);
    expect(issue.json<{ approvedByUserId: string }>().approvedByUserId).toBe(managerId);

    const balance = await app.inject({ method: "GET", url: `/invoices/${invoiceId}/refund-balance`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(balance.json<{ refundableMinor: string }>().refundableMinor).toBe("0");
  });

  it("rejects a refund with no manager PIN at all", async () => {
    const tenant = await createTenant("refund-e2e-no-pin");
    await setMistakeReasonCode(tenant);
    const invoiceId = await createPaidInvoice(tenant);

    const issue = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/refunds`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { amountMinor: "1000", reasonCode: "mistake" },
    });
    expect(issue.statusCode).toBe(400);
  });

  it("rejects a refund amount exceeding the invoice's refundable balance", async () => {
    const tenant = await createTenant("refund-e2e-exceeds");
    await setMistakeReasonCode(tenant);
    const managerId = await createManagerWithPin(tenant, "refund-e2e-exceeds-manager", "4321");
    const invoiceId = await createPaidInvoice(tenant);

    const issue = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/refunds`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { amountMinor: "999999", reasonCode: "mistake", managerUserId: managerId, managerPin: "4321" },
    });
    expect(issue.statusCode).toBe(400);
  });
});
