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

async function createTable(tenant: Tenant, name = "T1"): Promise<string> {
  const floor = await floorsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId: tenant.branchId, name: "Ground Floor" });
  const table = await tablesService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, floorId: floor.id, name });
  return table.id;
}

/** Catalog management lives in api-admin (not mounted here), so this goes straight through the DB — same convention as order-items.e2e.test.ts. */
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

    const history = await app.inject({ method: "GET", url: `/orders/${order.id}/status-history`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(history.statusCode).toBe(200);
    expect(history.json<{ fromStatus: string | null; toStatus: string }[]>().map((h) => [h.fromStatus, h.toStatus])).toEqual([
      [null, "open"],
      ["open", "closed"],
    ]);

    const recancel = await app.inject({ method: "POST", url: `/orders/${order.id}/cancel`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(recancel.statusCode).toBe(400);
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

    const historyByB = await app.inject({ method: "GET", url: `/orders/${orderId}/status-history`, headers: { authorization: `Bearer ${tenantB.accessToken}` } });
    expect(historyByB.statusCode).toBe(404);
  });

  it("an invalid or missing token is rejected", async () => {
    const noToken = await app.inject({ method: "GET", url: "/orders" });
    expect(noToken.statusCode).toBe(401);

    const garbageToken = await app.inject({ method: "GET", url: "/orders", headers: { authorization: "Bearer not-a-real-token" } });
    expect(garbageToken.statusCode).toBe(401);
  });

  it("holds and recalls a dine-in order, keeping its table occupied throughout, and exposes it via the table's tab", async () => {
    const tenant = await createTenant("order-hold-recall");
    const tableId = await createTable(tenant);

    const emptyTab = await app.inject({ method: "GET", url: `/tables/${tableId}/tab`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(emptyTab.statusCode).toBe(200);
    expect(emptyTab.json<{ order: unknown }>().order).toBeNull();

    const create = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { branchId: tenant.branchId, orderType: "dine_in", currency: "PKR", tableId },
    });
    const order = create.json<{ id: string }>();

    const hold = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/hold`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { reason: "Serving another table" },
    });
    expect(hold.statusCode).toBe(201);
    expect(hold.json<{ status: string }>().status).toBe("held");

    const tablesWhileHeld = await tablesService.list(tenant.restaurantId, tenant.branchId);
    expect(tablesWhileHeld.find((t) => t.id === tableId)?.status).toBe("occupied");

    const tabWhileHeld = await app.inject({ method: "GET", url: `/tables/${tableId}/tab`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(tabWhileHeld.json<{ order: { id: string } | null; totalMinor: string | null }>().order?.id).toBe(order.id);
    expect(tabWhileHeld.json<{ totalMinor: string | null }>().totalMinor).toBe("0");

    const closeWhileHeld = await app.inject({ method: "POST", url: `/orders/${order.id}/close`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(closeWhileHeld.statusCode).toBe(400);

    const recall = await app.inject({ method: "POST", url: `/orders/${order.id}/recall`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(recall.statusCode).toBe(201);
    expect(recall.json<{ status: string }>().status).toBe("open");

    const close = await app.inject({ method: "POST", url: `/orders/${order.id}/close`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(close.statusCode).toBe(201);

    const tablesAfterClose = await tablesService.list(tenant.restaurantId, tenant.branchId);
    expect(tablesAfterClose.find((t) => t.id === tableId)?.status).toBe("available");
  });

  it("one restaurant's token can never see or hold another restaurant's order, or another restaurant's table tab", async () => {
    const tenantA = await createTenant("order-hold-iso-a");
    const tenantB = await createTenant("order-hold-iso-b");
    const tableId = await createTable(tenantA);

    const create = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { authorization: `Bearer ${tenantA.accessToken}` },
      payload: { branchId: tenantA.branchId, orderType: "dine_in", currency: "PKR", tableId },
    });
    const orderId = create.json<{ id: string }>().id;

    const holdByB = await app.inject({ method: "POST", url: `/orders/${orderId}/hold`, headers: { authorization: `Bearer ${tenantB.accessToken}` } });
    expect(holdByB.statusCode).toBe(404);

    const tabByB = await app.inject({ method: "GET", url: `/tables/${tableId}/tab`, headers: { authorization: `Bearer ${tenantB.accessToken}` } });
    expect(tabByB.statusCode).toBe(404);
  });

  it("transfers a dine-in order to a free table (positive control), and rejects onto an already-occupied one", async () => {
    const tenant = await createTenant("order-transfer-ok");
    const tableA = await createTable(tenant, "T1");
    const tableB = await createTable(tenant, "T2");

    const create = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { branchId: tenant.branchId, orderType: "dine_in", currency: "PKR", tableId: tableA },
    });
    const order = create.json<{ id: string }>();

    const transfer = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/transfer`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { targetTableId: tableB },
    });
    expect(transfer.statusCode).toBe(201);
    expect(transfer.json<{ tableId: string }>().tableId).toBe(tableB);

    const tables = await tablesService.list(tenant.restaurantId, tenant.branchId);
    expect(tables.find((t) => t.id === tableA)?.status).toBe("available");
    expect(tables.find((t) => t.id === tableB)?.status).toBe("occupied");

    const tableC = await createTable(tenant, "T3");
    const second = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { branchId: tenant.branchId, orderType: "dine_in", currency: "PKR", tableId: tableC },
    });
    const conflictTransfer = await app.inject({
      method: "POST",
      url: `/orders/${second.json<{ id: string }>().id}/transfer`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { targetTableId: tableB },
    });
    expect(conflictTransfer.statusCode).toBe(400);
  });

  it("merges two tables' orders, moving items onto the target and cancelling the source", async () => {
    const tenant = await createTenant("order-merge-ok");
    const tableA = await createTable(tenant, "T1");
    const tableB = await createTable(tenant, "T2");
    const productId = await createPricedProduct(tenant, 1000n);

    const orderA = (
      await app.inject({
        method: "POST",
        url: "/orders",
        headers: { authorization: `Bearer ${tenant.accessToken}` },
        payload: { branchId: tenant.branchId, orderType: "dine_in", currency: "PKR", tableId: tableA },
      })
    ).json<{ id: string }>();
    const orderB = (
      await app.inject({
        method: "POST",
        url: "/orders",
        headers: { authorization: `Bearer ${tenant.accessToken}` },
        payload: { branchId: tenant.branchId, orderType: "dine_in", currency: "PKR", tableId: tableB },
      })
    ).json<{ id: string }>();
    const item = (
      await app.inject({
        method: "POST",
        url: `/orders/${orderA.id}/items`,
        headers: { authorization: `Bearer ${tenant.accessToken}` },
        payload: { productId },
      })
    ).json<{ id: string }>();

    const merge = await app.inject({
      method: "POST",
      url: `/orders/${orderA.id}/merge`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { targetTableId: tableB },
    });
    expect(merge.statusCode).toBe(201);
    const result = merge.json<{ targetOrder: { id: string }; sourceOrderId: string }>();
    expect(result.targetOrder.id).toBe(orderB.id);
    expect(result.sourceOrderId).toBe(orderA.id);

    const itemsOnTarget = await app.inject({ method: "GET", url: `/orders/${orderB.id}/items`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(itemsOnTarget.json<Array<{ id: string }>>().map((i) => i.id)).toEqual([item.id]);

    const tables = await tablesService.list(tenant.restaurantId, tenant.branchId);
    expect(tables.find((t) => t.id === tableA)?.status).toBe("available");
  });

  it("splits selected items off an order onto a new order at a free table", async () => {
    const tenant = await createTenant("order-split-ok");
    const tableA = await createTable(tenant, "T1");
    const tableB = await createTable(tenant, "T2");
    const productId = await createPricedProduct(tenant, 1000n);

    const order = (
      await app.inject({
        method: "POST",
        url: "/orders",
        headers: { authorization: `Bearer ${tenant.accessToken}` },
        payload: { branchId: tenant.branchId, orderType: "dine_in", currency: "PKR", tableId: tableA },
      })
    ).json<{ id: string }>();
    const keptItem = (
      await app.inject({ method: "POST", url: `/orders/${order.id}/items`, headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { productId } })
    ).json<{ id: string }>();
    const movedItem = (
      await app.inject({ method: "POST", url: `/orders/${order.id}/items`, headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { productId } })
    ).json<{ id: string }>();

    const split = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/split`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { targetTableId: tableB, itemIds: [movedItem.id] },
    });
    expect(split.statusCode).toBe(201);
    const result = split.json<{ sourceOrder: { id: string }; newOrder: { id: string; tableId: string } }>();
    expect(result.newOrder.tableId).toBe(tableB);

    const remaining = await app.inject({ method: "GET", url: `/orders/${order.id}/items`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(remaining.json<Array<{ id: string }>>().map((i) => i.id)).toEqual([keptItem.id]);

    const moved = await app.inject({ method: "GET", url: `/orders/${result.newOrder.id}/items`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(moved.json<Array<{ id: string }>>().map((i) => i.id)).toEqual([movedItem.id]);
  });

  it("one restaurant's token can never transfer, merge or split another restaurant's order", async () => {
    const tenantA = await createTenant("order-table-ops-iso-a");
    const tenantB = await createTenant("order-table-ops-iso-b");
    const tableA = await createTable(tenantA, "T1");
    const tableB = await createTable(tenantB, "T1");

    const order = (
      await app.inject({
        method: "POST",
        url: "/orders",
        headers: { authorization: `Bearer ${tenantA.accessToken}` },
        payload: { branchId: tenantA.branchId, orderType: "dine_in", currency: "PKR", tableId: tableA },
      })
    ).json<{ id: string }>();

    const transferByB = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/transfer`,
      headers: { authorization: `Bearer ${tenantB.accessToken}` },
      payload: { targetTableId: tableB },
    });
    expect(transferByB.statusCode).toBe(404);

    const mergeByB = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/merge`,
      headers: { authorization: `Bearer ${tenantB.accessToken}` },
      payload: { targetTableId: tableB },
    });
    expect(mergeByB.statusCode).toBe(404);

    const splitByB = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/split`,
      headers: { authorization: `Bearer ${tenantB.accessToken}` },
      payload: { targetTableId: tableB, itemIds: [randomUUID()] },
    });
    expect(splitByB.statusCode).toBe(404);
  });
});
