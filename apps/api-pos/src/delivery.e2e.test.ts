import { randomUUID } from "node:crypto";
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Pool } from "pg";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE, DEV_JWT_SECRET, PermissionGuard, PermissionsService, signAccessToken, TenantContextGuard } from "@mezbaan/nest-core";
import { AppModule } from "./app.module.js";

/** P2-10: customer/address capture, rider assignment and delivery status —
 * extends P2-09's orders, so it lives in api-pos too. Same fixture-via-DB,
 * sign-the-token-directly pattern as orders.e2e.test.ts (no /onboarding
 * route exists here). */
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

async function createDeliveryOrder(tenant: Tenant): Promise<string> {
  const create = await app.inject({
    method: "POST",
    url: "/orders",
    headers: { authorization: `Bearer ${tenant.accessToken}` },
    payload: { branchId: tenant.branchId, orderType: "delivery", currency: "PKR" },
  });
  if (create.statusCode !== 201) throw new Error(`fixture: order creation failed: ${create.statusCode} ${create.body}`);
  return create.json<{ id: string }>().id;
}

describe("delivery — customer capture, rider assignment and status (api-pos)", () => {
  it("captures customer and address details, creates a rider, assigns them, and updates status (positive control)", async () => {
    const tenant = await createTenant("delivery-ok");
    const orderId = await createDeliveryOrder(tenant);

    const setDetails = await app.inject({
      method: "PUT",
      url: `/orders/${orderId}/delivery`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { customerName: "Ali", customerPhone: "0300-1234567", addressLine1: "123 Main St", city: "Karachi" },
    });
    expect(setDetails.statusCode).toBe(200);
    expect(setDetails.json<{ deliveryStatus: string }>().deliveryStatus).toBe("pending");

    const createRider = await app.inject({
      method: "POST",
      url: "/delivery-riders",
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { branchId: tenant.branchId, name: "Zain", phone: "0300-7654321" },
    });
    expect(createRider.statusCode).toBe(201);
    const riderId = createRider.json<{ id: string }>().id;

    const assign = await app.inject({
      method: "PATCH",
      url: `/orders/${orderId}/delivery/rider`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { riderId },
    });
    expect(assign.statusCode).toBe(200);
    const assigned = assign.json<{ riderId: string; deliveryStatus: string }>();
    expect(assigned.riderId).toBe(riderId);
    expect(assigned.deliveryStatus).toBe("assigned");

    const markDelivered = await app.inject({
      method: "PATCH",
      url: `/orders/${orderId}/delivery/status`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { status: "delivered" },
    });
    expect(markDelivered.statusCode).toBe(200);
    expect(markDelivered.json<{ deliveryStatus: string }>().deliveryStatus).toBe("delivered");
  });

  it("rejects setting delivery details on a takeaway order", async () => {
    const tenant = await createTenant("delivery-wrong-type");
    const create = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { branchId: tenant.branchId, orderType: "takeaway", currency: "PKR" },
    });
    const orderId = create.json<{ id: string }>().id;

    const setDetails = await app.inject({
      method: "PUT",
      url: `/orders/${orderId}/delivery`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { customerName: "Ali", customerPhone: "0300", addressLine1: "123 Main St" },
    });
    expect(setDetails.statusCode).toBe(400);
  });

  it("one restaurant's token can never see or update another restaurant's delivery details or riders", async () => {
    const tenantA = await createTenant("delivery-iso-a");
    const tenantB = await createTenant("delivery-iso-b");
    const orderId = await createDeliveryOrder(tenantA);
    await app.inject({
      method: "PUT",
      url: `/orders/${orderId}/delivery`,
      headers: { authorization: `Bearer ${tenantA.accessToken}` },
      payload: { customerName: "Ali", customerPhone: "0300", addressLine1: "123 Main St" },
    });
    const createRider = await app.inject({
      method: "POST",
      url: "/delivery-riders",
      headers: { authorization: `Bearer ${tenantA.accessToken}` },
      payload: { branchId: tenantA.branchId, name: "Zain", phone: "0300" },
    });
    const riderId = createRider.json<{ id: string }>().id;

    const getByB = await app.inject({ method: "GET", url: `/orders/${orderId}/delivery`, headers: { authorization: `Bearer ${tenantB.accessToken}` } });
    expect(getByB.json()).toBeNull();

    const ridersByB = await app.inject({ method: "GET", url: "/delivery-riders", headers: { authorization: `Bearer ${tenantB.accessToken}` } });
    expect(ridersByB.json<unknown[]>()).toEqual([]);

    const assignByB = await app.inject({
      method: "PATCH",
      url: `/orders/${orderId}/delivery/rider`,
      headers: { authorization: `Bearer ${tenantB.accessToken}` },
      payload: { riderId },
    });
    // The order itself isn't visible to tenant B under RLS, so this 404s as "order not found" before ever reaching the rider check.
    expect(assignByB.statusCode).toBe(404);
  });
});
