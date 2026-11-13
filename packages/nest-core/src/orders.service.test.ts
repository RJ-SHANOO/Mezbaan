import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { CategoriesService } from "./categories.service.js";
import { DiningTablesService } from "./dining-tables.service.js";
import { FloorsService } from "./floors.service.js";
import { OrderItemsService } from "./order-items.service.js";
import { OrdersService } from "./orders.service.js";
import { PriceListItemsService } from "./price-list-items.service.js";
import { PriceListsService } from "./price-lists.service.js";
import { PriceResolutionService } from "./price-resolution.service.js";
import { ProductsService } from "./products.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: OrdersService;
let floorsService: FloorsService;
let tablesService: DiningTablesService;
let orderItemsService: OrderItemsService;
let categoriesService: CategoriesService;
let productsService: ProductsService;
let priceListsService: PriceListsService;
let priceListItemsService: PriceListItemsService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  const priceResolutionService = new PriceResolutionService(db);
  orderItemsService = new OrderItemsService(db, auditLogService, priceResolutionService);
  service = new OrdersService(db, auditLogService, orderItemsService);
  floorsService = new FloorsService(db, auditLogService);
  tablesService = new DiningTablesService(db, auditLogService);
  categoriesService = new CategoriesService(db, auditLogService);
  productsService = new ProductsService(db, auditLogService);
  priceListsService = new PriceListsService(db, auditLogService);
  priceListItemsService = new PriceListItemsService(db, auditLogService);
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

async function createTable(restaurantId: string, ownerUserId: string, branchId: string, name = "T1"): Promise<string> {
  const floor = await floorsService.create({ restaurantId, actorUserId: ownerUserId, branchId, name: "Ground Floor" });
  const table = await tablesService.create({ restaurantId, actorUserId: ownerUserId, floorId: floor.id, name });
  return table.id;
}

async function createPricedProduct(restaurantId: string, actorUserId: string, unitPriceMinor: bigint, currency = "PKR"): Promise<string> {
  const category = await categoriesService.create({ restaurantId, actorUserId, name: "Burgers" });
  const product = await productsService.create({ restaurantId, actorUserId, categoryId: category.id, name: "Cheeseburger" });
  const priceList = await priceListsService.create({ restaurantId, actorUserId, name: `List-${randomUUID()}`, currency });
  await priceListItemsService.setPrice({ restaurantId, actorUserId, priceListId: priceList.id, productId: product.id, unitPriceMinor });
  await priceListsService.publish({ restaurantId, actorUserId, priceListId: priceList.id });
  return product.id;
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

  it("records status history on open and close, in order", async () => {
    const tenant = await createRestaurant("order-status-history");
    const branchId = await createBranch(tenant.restaurantId);

    const order = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "takeaway", currency: "PKR" });
    await service.close({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId });

    const history = await service.getStatusHistory({ restaurantId: tenant.restaurantId, orderId: order.id });
    expect(history.map((h) => [h.fromStatus, h.toStatus])).toEqual([
      [null, "open"],
      ["open", "closed"],
    ]);
  });

  it("rejects cancelling an already-closed order (closed is a dead end, not just not-open)", async () => {
    const tenant = await createRestaurant("order-closed-no-cancel");
    const branchId = await createBranch(tenant.restaurantId);

    const order = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "takeaway", currency: "PKR" });
    await service.close({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId });

    await expect(service.cancel({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId })).rejects.toThrow(BadRequestException);
  });

  it("holds a dine-in order without freeing its table, then recalls it back to open", async () => {
    const tenant = await createRestaurant("order-hold-recall-dinein");
    const branchId = await createBranch(tenant.restaurantId);
    const tableId = await createTable(tenant.restaurantId, tenant.ownerUserId, branchId);

    const order = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "dine_in", currency: "PKR", tableId });

    const held = await service.hold({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId, reason: "Serving another table" });
    expect(held.status).toBe("held");
    expect(held.closedAt).toBeNull();

    const tablesWhileHeld = await tablesService.list(tenant.restaurantId, branchId);
    expect(tablesWhileHeld.find((t) => t.id === tableId)?.status).toBe("occupied");

    // a second dine-in order on the same table is still rejected while the first is only held
    await expect(
      service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "dine_in", currency: "PKR", tableId }),
    ).rejects.toThrow(BadRequestException);

    const recalled = await service.recall({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId });
    expect(recalled.status).toBe("open");

    const closed = await service.close({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId });
    expect(closed.status).toBe("closed");
    const tablesAfterClose = await tablesService.list(tenant.restaurantId, branchId);
    expect(tablesAfterClose.find((t) => t.id === tableId)?.status).toBe("available");

    const history = await service.getStatusHistory({ restaurantId: tenant.restaurantId, orderId: order.id });
    expect(history.map((h) => [h.fromStatus, h.toStatus])).toEqual([
      [null, "open"],
      ["open", "held"],
      ["held", "open"],
      ["open", "closed"],
    ]);
  });

  it("rejects closing a held order directly, and rejects recalling an order that was never held", async () => {
    const tenant = await createRestaurant("order-held-no-direct-close");
    const branchId = await createBranch(tenant.restaurantId);

    const order = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "takeaway", currency: "PKR" });
    await expect(service.recall({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId })).rejects.toThrow(BadRequestException);

    await service.hold({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId });
    await expect(service.close({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId })).rejects.toThrow(BadRequestException);

    const cancelled = await service.cancel({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId });
    expect(cancelled.status).toBe("cancelled");
  });

  it("returns a table's running tab: null when empty, then the open order's items and total", async () => {
    const tenant = await createRestaurant("order-table-tab");
    const branchId = await createBranch(tenant.restaurantId);
    const tableId = await createTable(tenant.restaurantId, tenant.ownerUserId, branchId);

    const empty = await service.getTableTab({ restaurantId: tenant.restaurantId, tableId });
    expect(empty).toEqual({ tableId, order: null, items: [], total: null });

    const order = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "dine_in", currency: "PKR", tableId });
    await service.hold({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId });

    const whileHeld = await service.getTableTab({ restaurantId: tenant.restaurantId, tableId });
    expect(whileHeld.order?.id).toBe(order.id);
    expect(whileHeld.items).toEqual([]);
    expect(whileHeld.total).toEqual({ amountMinor: 0n, currency: "PKR" });
  });

  it("transfers a dine-in order to a free table, freeing the old one and occupying the new one", async () => {
    const tenant = await createRestaurant("order-transfer");
    const branchId = await createBranch(tenant.restaurantId);
    const tableA = await createTable(tenant.restaurantId, tenant.ownerUserId, branchId, "T1");
    const tableB = await createTable(tenant.restaurantId, tenant.ownerUserId, branchId, "T2");

    const order = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "dine_in", currency: "PKR", tableId: tableA });

    const transferred = await service.transferTable({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId, targetTableId: tableB });
    expect(transferred.tableId).toBe(tableB);
    expect(transferred.status).toBe("open");

    const tables = await tablesService.list(tenant.restaurantId, branchId);
    expect(tables.find((t) => t.id === tableA)?.status).toBe("available");
    expect(tables.find((t) => t.id === tableB)?.status).toBe("occupied");

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "order.table_transferred" && row.targetId === order.id)).toBe(true);
  });

  it("rejects transferring a takeaway order, a closed order, or onto an already-occupied table", async () => {
    const tenant = await createRestaurant("order-transfer-rejections");
    const branchId = await createBranch(tenant.restaurantId);
    const tableA = await createTable(tenant.restaurantId, tenant.ownerUserId, branchId, "T1");
    const tableB = await createTable(tenant.restaurantId, tenant.ownerUserId, branchId, "T2");

    const takeaway = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "takeaway", currency: "PKR" });
    await expect(
      service.transferTable({ restaurantId: tenant.restaurantId, orderId: takeaway.id, actorUserId: tenant.ownerUserId, targetTableId: tableB }),
    ).rejects.toThrow(BadRequestException);

    const dineIn = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "dine_in", currency: "PKR", tableId: tableA });
    await service.close({ restaurantId: tenant.restaurantId, orderId: dineIn.id, actorUserId: tenant.ownerUserId });
    await expect(
      service.transferTable({ restaurantId: tenant.restaurantId, orderId: dineIn.id, actorUserId: tenant.ownerUserId, targetTableId: tableB }),
    ).rejects.toThrow(BadRequestException);

    const tableC = await createTable(tenant.restaurantId, tenant.ownerUserId, branchId, "T3");
    const order = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "dine_in", currency: "PKR", tableId: tableC });
    await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "dine_in", currency: "PKR", tableId: tableB });
    await expect(
      service.transferTable({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId, targetTableId: tableB }),
    ).rejects.toThrow(BadRequestException);
  });

  it("merges one table's order into another's, moving items, cancelling the source order and freeing its table", async () => {
    const tenant = await createRestaurant("order-merge");
    const branchId = await createBranch(tenant.restaurantId);
    const tableA = await createTable(tenant.restaurantId, tenant.ownerUserId, branchId, "T1");
    const tableB = await createTable(tenant.restaurantId, tenant.ownerUserId, branchId, "T2");
    const productId = await createPricedProduct(tenant.restaurantId, tenant.ownerUserId, 1000n);

    const orderA = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "dine_in", currency: "PKR", tableId: tableA });
    const orderB = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "dine_in", currency: "PKR", tableId: tableB });
    const item = await orderItemsService.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId: orderA.id, productId });

    const result = await service.mergeTables({ restaurantId: tenant.restaurantId, orderId: orderA.id, actorUserId: tenant.ownerUserId, targetTableId: tableB });
    expect(result.targetOrder.id).toBe(orderB.id);
    expect(result.sourceOrderId).toBe(orderA.id);

    const movedItems = await orderItemsService.list(tenant.restaurantId, orderB.id);
    expect(movedItems.map((i) => i.id)).toEqual([item.id]);

    const tables = await tablesService.list(tenant.restaurantId, branchId);
    expect(tables.find((t) => t.id === tableA)?.status).toBe("available");
    expect(tables.find((t) => t.id === tableB)?.status).toBe("occupied");

    const history = await service.getStatusHistory({ restaurantId: tenant.restaurantId, orderId: orderA.id });
    expect(history.at(-1)?.toStatus).toBe("cancelled");

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "order.tables_merged" && row.targetId === orderB.id)).toBe(true);
  });

  it("rejects merging onto a table with no open or held order, or merging a table into itself", async () => {
    const tenant = await createRestaurant("order-merge-rejections");
    const branchId = await createBranch(tenant.restaurantId);
    const tableA = await createTable(tenant.restaurantId, tenant.ownerUserId, branchId, "T1");
    const tableB = await createTable(tenant.restaurantId, tenant.ownerUserId, branchId, "T2");

    const orderA = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "dine_in", currency: "PKR", tableId: tableA });

    await expect(
      service.mergeTables({ restaurantId: tenant.restaurantId, orderId: orderA.id, actorUserId: tenant.ownerUserId, targetTableId: tableB }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.mergeTables({ restaurantId: tenant.restaurantId, orderId: orderA.id, actorUserId: tenant.ownerUserId, targetTableId: tableA }),
    ).rejects.toThrow(BadRequestException);
  });

  it("splits selected items off a table's order onto a new order at a free table, leaving the rest behind", async () => {
    const tenant = await createRestaurant("order-split");
    const branchId = await createBranch(tenant.restaurantId);
    const tableA = await createTable(tenant.restaurantId, tenant.ownerUserId, branchId, "T1");
    const tableB = await createTable(tenant.restaurantId, tenant.ownerUserId, branchId, "T2");
    const productId = await createPricedProduct(tenant.restaurantId, tenant.ownerUserId, 1000n);

    const order = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "dine_in", currency: "PKR", tableId: tableA });
    const keptItem = await orderItemsService.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId: order.id, productId });
    const movedItem = await orderItemsService.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId: order.id, productId });

    const result = await service.splitTable({
      restaurantId: tenant.restaurantId,
      orderId: order.id,
      actorUserId: tenant.ownerUserId,
      targetTableId: tableB,
      itemIds: [movedItem.id],
    });
    expect(result.newOrder.tableId).toBe(tableB);
    expect(result.newOrder.status).toBe("open");
    expect(result.sourceOrder.id).toBe(order.id);

    const remaining = await orderItemsService.list(tenant.restaurantId, order.id);
    expect(remaining.map((i) => i.id)).toEqual([keptItem.id]);
    const moved = await orderItemsService.list(tenant.restaurantId, result.newOrder.id);
    expect(moved.map((i) => i.id)).toEqual([movedItem.id]);

    const tables = await tablesService.list(tenant.restaurantId, branchId);
    expect(tables.find((t) => t.id === tableA)?.status).toBe("occupied");
    expect(tables.find((t) => t.id === tableB)?.status).toBe("occupied");

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "order.split" && row.targetId === order.id)).toBe(true);
  });

  it("rejects splitting with no items, with an item that isn't on the order, or moving every item off the order", async () => {
    const tenant = await createRestaurant("order-split-rejections");
    const branchId = await createBranch(tenant.restaurantId);
    const tableA = await createTable(tenant.restaurantId, tenant.ownerUserId, branchId, "T1");
    const tableB = await createTable(tenant.restaurantId, tenant.ownerUserId, branchId, "T2");
    const productId = await createPricedProduct(tenant.restaurantId, tenant.ownerUserId, 1000n);

    const order = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "dine_in", currency: "PKR", tableId: tableA });
    const item = await orderItemsService.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId: order.id, productId });

    await expect(
      service.splitTable({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId, targetTableId: tableB, itemIds: [] }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.splitTable({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId, targetTableId: tableB, itemIds: [randomUUID()] }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      service.splitTable({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId, targetTableId: tableB, itemIds: [item.id] }),
    ).rejects.toThrow(BadRequestException);
  });

  describe("P2-16: two terminals racing the same table or order", () => {
    it("two terminals opening a dine-in order on the same table at once: exactly one succeeds", async () => {
      const tenant = await createRestaurant("order-race-table");
      const branchId = await createBranch(tenant.restaurantId);
      const tableId = await createTable(tenant.restaurantId, tenant.ownerUserId, branchId);

      const results = await Promise.allSettled([
        service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "dine_in", currency: "PKR", tableId }),
        service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "dine_in", currency: "PKR", tableId }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestException);

      // The table-occupancy index is the real guard — confirm it actually left
      // exactly one open order behind, not (impossibly) zero or two.
      const openOrders = await service.list({ restaurantId: tenant.restaurantId, branchId, status: "open" });
      expect(openOrders.filter((o) => o.tableId === tableId)).toHaveLength(1);
    });

    it("two terminals transitioning the same order at once: the loser sees the real outcome, not stale data", async () => {
      const tenant = await createRestaurant("order-race-transition");
      const branchId = await createBranch(tenant.restaurantId);
      const order = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "takeaway", currency: "PKR" });

      const results = await Promise.allSettled([
        service.close({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId }),
        service.cancel({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId }),
      ]);

      // Row locking (FOR UPDATE) serializes the two transitions rather than
      // letting both read the same "open" snapshot and both silently commit —
      // whichever goes second must see the first's committed status and
      // correctly reject re-transitioning an already-final order.
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestException);

      const history = await service.getStatusHistory({ restaurantId: tenant.restaurantId, orderId: order.id });
      expect(history).toHaveLength(2);
      expect(history.filter((h) => h.toStatus === "closed" || h.toStatus === "cancelled")).toHaveLength(1);
    });
  });
});
