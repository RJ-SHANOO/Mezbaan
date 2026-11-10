import { randomUUID } from "node:crypto";
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Pool } from "pg";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import {
  AuditLogService,
  DATABASE,
  DEV_JWT_SECRET,
  DiningTablesService,
  FloorsService,
  PermissionGuard,
  PermissionsService,
  signAccessToken,
  TenantContextGuard,
} from "@mezbaan/nest-core";
import { AppModule } from "./app.module.js";

/**
 * Orders (P2-09) belong in api-pos, not api-admin — this is "the POS and sync
 * API" per CLAUDE.md's repo structure, unlike the catalog/pricing/table-layout
 * tasks before it which are all admin-managed config. There's no
 * OnboardingModule here (no /onboarding/signup route), so fixtures go
 * straight through the DB, same as devices.e2e.test.ts, and the access token
 * is signed directly rather than obtained via a login round trip.
 */
const SECRET = process.env.JWT_SECRET ?? DEV_JWT_SECRET;
const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let app: NestFastifyApplication;
let pool: Pool;
let db: Database;
let floorsService: FloorsService;
let tablesService: DiningTablesService;

beforeAll(async () => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  floorsService = new FloorsService(db, auditLogService);
  tablesService = new DiningTablesService(db, auditLogService);

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

async function createTable(tenant: Tenant): Promise<string> {
  const floor = await floorsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId: tenant.branchId, name: "Ground Floor" });
  const table = await tablesService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, floorId: floor.id, name: "T1" });
  return table.id;
}

describe("orders — tenant isolation and workflow (api-pos)", () => {
  it("opens a dine-in order, occupies the table, closes it, and frees the table again (positive control)", async () => {
    const tenant = await createTenant("order-dinein-ok");
    const tableId = await createTable(tenant);

    const create = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { branchId: tenant.branchId, orderType: "dine_in", currency: "PKR", tableId },
    });
    expect(create.statusCode).toBe(201);
    const order = create.json<{ id: string; status: string; tableId: string }>();
    expect(order.status).toBe("open");
    expect(order.tableId).toBe(tableId);

    const tablesAfterOpen = await tablesService.list(tenant.restaurantId, tenant.branchId);
    expect(tablesAfterOpen.find((t) => t.id === tableId)?.status).toBe("occupied");

    const close = await app.inject({ method: "POST", url: `/orders/${order.id}/close`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(close.statusCode).toBe(201);
    expect(close.json<{ status: string }>().status).toBe("closed");

    const tablesAfterClose = await tablesService.list(tenant.restaurantId, tenant.branchId);
    expect(tablesAfterClose.find((t) => t.id === tableId)?.status).toBe("available");
  });

  it("rejects opening a second dine-in order on a table that already has one open", async () => {
    const tenant = await createTenant("order-dinein-conflict");
    const tableId = await createTable(tenant);

    const first = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { branchId: tenant.branchId, orderType: "dine_in", currency: "PKR", tableId },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { branchId: tenant.branchId, orderType: "dine_in", currency: "PKR", tableId },
    });
    expect(second.statusCode).toBe(400);
  });

  it("opens a takeaway order with no table, and cancelling it records the reason", async () => {
    const tenant = await createTenant("order-takeaway-ok");

    const create = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { branchId: tenant.branchId, orderType: "takeaway", currency: "PKR" },
    });
    expect(create.statusCode).toBe(201);
    const order = create.json<{ id: string; tableId: string | null }>();
    expect(order.tableId).toBeNull();

    const cancel = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/cancel`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { reason: "Customer changed their mind" },
    });
    expect(cancel.statusCode).toBe(201);
    expect(cancel.json<{ status: string }>().status).toBe("cancelled");
  });

  it("rejects a dine-in order with no tableId, and a takeaway order with one", async () => {
    const tenant = await createTenant("order-shape-validation");
    const tableId = await createTable(tenant);

    const missingTable = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { branchId: tenant.branchId, orderType: "dine_in", currency: "PKR" },
    });
    expect(missingTable.statusCode).toBe(400);

    const unexpectedTable = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { branchId: tenant.branchId, orderType: "takeaway", currency: "PKR", tableId },
    });
    expect(unexpectedTable.statusCode).toBe(400);
  });

  it("one restaurant's token can never see or close another restaurant's orders", async () => {
    const tenantA = await createTenant("order-iso-a");
    const tenantB = await createTenant("order-iso-b");

    const create = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { authorization: `Bearer ${tenantA.accessToken}` },
      payload: { branchId: tenantA.branchId, orderType: "takeaway", currency: "PKR" },
    });
    const orderId = create.json<{ id: string }>().id;

    const listByB = await app.inject({ method: "GET", url: "/orders", headers: { authorization: `Bearer ${tenantB.accessToken}` } });
    expect(listByB.json<unknown[]>()).toEqual([]);

    const closeByB = await app.inject({ method: "POST", url: `/orders/${orderId}/close`, headers: { authorization: `Bearer ${tenantB.accessToken}` } });
    expect(closeByB.statusCode).toBe(404);
  });

  it("an invalid or missing token is rejected", async () => {
    const noToken = await app.inject({ method: "GET", url: "/orders" });
    expect(noToken.statusCode).toBe(401);

    const garbageToken = await app.inject({ method: "GET", url: "/orders", headers: { authorization: "Bearer not-a-real-token" } });
    expect(garbageToken.statusCode).toBe(401);
  });
});
