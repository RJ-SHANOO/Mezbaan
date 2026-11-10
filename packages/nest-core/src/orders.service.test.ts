import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { DiningTablesService } from "./dining-tables.service.js";
import { FloorsService } from "./floors.service.js";
import { OrdersService } from "./orders.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: OrdersService;
let floorsService: FloorsService;
let tablesService: DiningTablesService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  service = new OrdersService(db, auditLogService);
  floorsService = new FloorsService(db, auditLogService);
  tablesService = new DiningTablesService(db, auditLogService);
});

afterAll(async () => {
  await pool.end();
});

async function createRestaurant(label: string): Promise<{ restaurantId: string; ownerUserId: string }> {
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

  const ownerRows = await withTenant(db, { restaurantId: restaurant.id }, (tx) =>
    tx
      .insert(schema.users)
      .values({ restaurantId: restaurant.id, roleId: role.id, email: `${label}@example.test`, passwordHash: "unused", displayName: label })
      .returning({ id: schema.users.id }),
  );
  const owner = ownerRows[0];
  if (!owner) throw new Error("fixture: user insert returned no row");

  return { restaurantId: restaurant.id, ownerUserId: owner.id };
}

async function createBranch(restaurantId: string): Promise<string> {
  const rows = await withTenant(db, { restaurantId }, (tx) =>
    tx.insert(schema.branches).values({ restaurantId, name: "Main", timezone: "Asia/Karachi" }).returning({ id: schema.branches.id }),
  );
  const branch = rows[0];
  if (!branch) throw new Error("fixture: branch insert returned no row");
  return branch.id;
}

async function createTable(restaurantId: string, ownerUserId: string, branchId: string): Promise<string> {
  const floor = await floorsService.create({ restaurantId, actorUserId: ownerUserId, branchId, name: "Ground Floor" });
  const table = await tablesService.create({ restaurantId, actorUserId: ownerUserId, floorId: floor.id, name: "T1" });
  return table.id;
}

describe("OrdersService", () => {
  it("opens a dine-in order, occupies the table, closes it, and frees the table again", async () => {
    const tenant = await createRestaurant("order-dinein");
    const branchId = await createBranch(tenant.restaurantId);
    const tableId = await createTable(tenant.restaurantId, tenant.ownerUserId, branchId);

    const order = await service.create({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.ownerUserId,
      branchId,
      orderType: "dine_in",
      currency: "PKR",
      tableId,
    });
    expect(order.status).toBe("open");

    const occupiedTables = await tablesService.list(tenant.restaurantId, branchId);
    expect(occupiedTables.find((t) => t.id === tableId)?.status).toBe("occupied");

    const closed = await service.close({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId });
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).not.toBeNull();

    const freedTables = await tablesService.list(tenant.restaurantId, branchId);
    expect(freedTables.find((t) => t.id === tableId)?.status).toBe("available");

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "order.opened" && row.targetId === order.id)).toBe(true);
    expect(auditRows.some((row) => row.action === "order.closed" && row.targetId === order.id)).toBe(true);
  });

  it("rejects a second dine-in order on a table that already has one open", async () => {
    const tenant = await createRestaurant("order-dinein-conflict");
    const branchId = await createBranch(tenant.restaurantId);
    const tableId = await createTable(tenant.restaurantId, tenant.ownerUserId, branchId);

    await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "dine_in", currency: "PKR", tableId });

    await expect(
      service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "dine_in", currency: "PKR", tableId }),
    ).rejects.toThrow(BadRequestException);
  });

  it("allows a new dine-in order on the same table once the previous one is closed", async () => {
    const tenant = await createRestaurant("order-dinein-reuse");
    const branchId = await createBranch(tenant.restaurantId);
    const tableId = await createTable(tenant.restaurantId, tenant.ownerUserId, branchId);

    const first = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "dine_in", currency: "PKR", tableId });
    await service.close({ restaurantId: tenant.restaurantId, orderId: first.id, actorUserId: tenant.ownerUserId });

    const second = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "dine_in", currency: "PKR", tableId });
    expect(second.status).toBe("open");
  });

  it("opens a takeaway order with no table, and cancelling records a reason without touching any table", async () => {
    const tenant = await createRestaurant("order-takeaway");
    const branchId = await createBranch(tenant.restaurantId);

    const order = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "takeaway", currency: "PKR" });
    expect(order.tableId).toBeNull();

    const cancelled = await service.cancel({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId, reason: "Changed mind" });
    expect(cancelled.status).toBe("cancelled");

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    const cancelRow = auditRows.find((row) => row.action === "order.cancelled" && row.targetId === order.id);
    expect((cancelRow?.metadata as { reason?: string } | null)?.reason).toBe("Changed mind");
  });

  it("rejects a dine-in order with no tableId, and a takeaway order with one", async () => {
    const tenant = await createRestaurant("order-shape");
    const branchId = await createBranch(tenant.restaurantId);
    const tableId = await createTable(tenant.restaurantId, tenant.ownerUserId, branchId);

    await expect(
      service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "dine_in", currency: "PKR" }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "takeaway", currency: "PKR", tableId }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects closing an already-closed order, and closing an unknown order", async () => {
    const tenant = await createRestaurant("order-double-close");
    const branchId = await createBranch(tenant.restaurantId);

    const order = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "takeaway", currency: "PKR" });
    await service.close({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId });

    await expect(service.close({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId })).rejects.toThrow(BadRequestException);
    await expect(service.close({ restaurantId: tenant.restaurantId, orderId: randomUUID(), actorUserId: tenant.ownerUserId })).rejects.toThrow(NotFoundException);
  });

  it("rejects a table from another restaurant", async () => {
    const tenant = await createRestaurant("order-cross-table");
    const otherTenant = await createRestaurant("order-cross-table-other");
    const branchId = await createBranch(tenant.restaurantId);
    const otherBranchId = await createBranch(otherTenant.restaurantId);
    const otherTableId = await createTable(otherTenant.restaurantId, otherTenant.ownerUserId, otherBranchId);

    await expect(
      service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "dine_in", currency: "PKR", tableId: otherTableId }),
    ).rejects.toThrow(NotFoundException);
  });

  it("lists orders filtered by branch and status", async () => {
    const tenant = await createRestaurant("order-list-filter");
    const branchA = await createBranch(tenant.restaurantId);
    const branchB = await createBranch(tenant.restaurantId);
    const openOrder = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId: branchA, orderType: "takeaway", currency: "PKR" });
    await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId: branchB, orderType: "takeaway", currency: "PKR" });
    await service.close({ restaurantId: tenant.restaurantId, orderId: openOrder.id, actorUserId: tenant.ownerUserId });

    const branchAOrders = await service.list({ restaurantId: tenant.restaurantId, branchId: branchA });
    expect(branchAOrders.map((o) => o.id)).toEqual([openOrder.id]);

    const closedOrders = await service.list({ restaurantId: tenant.restaurantId, status: "closed" });
    expect(closedOrders.map((o) => o.id)).toContain(openOrder.id);
  });
});
