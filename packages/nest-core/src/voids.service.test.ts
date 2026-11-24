import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { CategoriesService } from "./categories.service.js";
import { ManagerPinService } from "./manager-pin.service.js";
import { OrderItemsService } from "./order-items.service.js";
import { computeOrderTotal, OrdersService } from "./orders.service.js";
import { PermissionsService } from "./permissions.service.js";
import { PriceListItemsService } from "./price-list-items.service.js";
import { PriceListsService } from "./price-lists.service.js";
import { PriceResolutionService } from "./price-resolution.service.js";
import { ProductsService } from "./products.service.js";
import { RecipesService } from "./recipes.service.js";
import { StockLedgerService } from "./stock-ledger.service.js";
import { StockLevelsService } from "./stock-levels.service.js";
import { NegativeStockFlagsService } from "./negative-stock-flags.service.js";
import { VoidsService } from "./voids.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: VoidsService;
let managerPinService: ManagerPinService;
let ordersService: OrdersService;
let orderItemsService: OrderItemsService;
let categoriesService: CategoriesService;
let productsService: ProductsService;
let priceListsService: PriceListsService;
let priceListItemsService: PriceListItemsService;
let managerRoleId: string;

beforeAll(async () => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  const priceResolutionService = new PriceResolutionService(db);
  const permissionsService = new PermissionsService(db);
  orderItemsService = new OrderItemsService(db, auditLogService, priceResolutionService);
  ordersService = new OrdersService(db, auditLogService, orderItemsService);
  categoriesService = new CategoriesService(db, auditLogService);
  productsService = new ProductsService(db, auditLogService);
  priceListsService = new PriceListsService(db, auditLogService);
  priceListItemsService = new PriceListItemsService(db, auditLogService);
  managerPinService = new ManagerPinService(db, permissionsService, auditLogService, {});
  const recipesService = new RecipesService(db, auditLogService);
  const stockLevelsService = new StockLevelsService(db);
  const negativeStockFlagsService = new NegativeStockFlagsService(db, auditLogService);
  const stockLedgerService = new StockLedgerService(db, auditLogService, stockLevelsService, negativeStockFlagsService);
  service = new VoidsService(db, auditLogService, managerPinService, recipesService, stockLedgerService);

  // Same "don't depend on seed.ts having run" reasoning as discounts.service.test.ts
  // — grant the real pos.void.approve key directly, idempotently, since VoidsService
  // hardcodes that exact string.
  const roleRows = await db
    .insert(schema.roles)
    .values({ key: "branch_manager", name: "Branch Manager" })
    .onConflictDoUpdate({ target: schema.roles.key, set: { name: schema.roles.name } })
    .returning({ id: schema.roles.id });
  managerRoleId = roleRows[0]?.id ?? "";
  if (!managerRoleId) throw new Error("fixture: role insert returned no row");

  const permissionRows = await db
    .insert(schema.permissions)
    .values({ key: "pos.void.approve", description: "test fixture" })
    .onConflictDoUpdate({ target: schema.permissions.key, set: { description: schema.permissions.description } })
    .returning({ id: schema.permissions.id });
  const permissionId = permissionRows[0]?.id;
  if (!permissionId) throw new Error("fixture: permission insert returned no row");
  await db.insert(schema.rolePermissions).values({ roleId: managerRoleId, permissionId }).onConflictDoNothing();
});

afterAll(async () => {
  await pool.end();
});

interface Tenant {
  restaurantId: string;
  ownerUserId: string;
}

async function createRestaurant(label: string): Promise<Tenant> {
  const restaurantRows = await withTenant(db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
    tx
      .insert(schema.restaurants)
      .values({ name: label, slug: `${label}-${randomUUID()}`, commissionRateBasisPoints: 500 })
      .returning({ id: schema.restaurants.id }),
  );
  const restaurant = restaurantRows[0];
  if (!restaurant) throw new Error("fixture: restaurant insert returned no row");

  const ownerRoleRows = await db
    .insert(schema.roles)
    .values({ key: "owner", name: "Restaurant Owner" })
    .onConflictDoUpdate({ target: schema.roles.key, set: { name: "Restaurant Owner" } })
    .returning({ id: schema.roles.id });
  const ownerRoleId = ownerRoleRows[0]?.id;
  if (!ownerRoleId) throw new Error("fixture: role insert returned no row");

  const ownerRows = await withTenant(db, { restaurantId: restaurant.id }, (tx) =>
    tx
      .insert(schema.users)
      .values({ restaurantId: restaurant.id, roleId: ownerRoleId, email: `${label}@example.test`, passwordHash: "unused", displayName: label })
      .returning({ id: schema.users.id }),
  );
  const owner = ownerRows[0];
  if (!owner) throw new Error("fixture: user insert returned no row");

  return { restaurantId: restaurant.id, ownerUserId: owner.id };
}

async function createManager(tenant: Tenant, label: string, pin: string): Promise<string> {
  const rows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) =>
    tx
      .insert(schema.users)
      .values({ restaurantId: tenant.restaurantId, roleId: managerRoleId, email: `${label}@example.test`, passwordHash: "unused", displayName: label })
      .returning({ id: schema.users.id }),
  );
  const manager = rows[0];
  if (!manager) throw new Error("fixture: manager insert returned no row");
  await managerPinService.setPin({ restaurantId: tenant.restaurantId, userId: manager.id, pin });
  return manager.id;
}

async function createBranch(restaurantId: string): Promise<string> {
  const rows = await withTenant(db, { restaurantId }, (tx) =>
    tx.insert(schema.branches).values({ restaurantId, name: "Main", timezone: "Asia/Karachi" }).returning({ id: schema.branches.id }),
  );
  const branch = rows[0];
  if (!branch) throw new Error("fixture: branch insert returned no row");
  return branch.id;
}

async function createOpenOrderWithItem(tenant: Tenant, branchId: string, unitPriceMinor = 10_000n): Promise<{ orderId: string; itemId: string }> {
  const category = await categoriesService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Burgers" });
  const product = await productsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, categoryId: category.id, name: "Cheeseburger" });
  const priceList = await priceListsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: `List-${randomUUID()}`, currency: "PKR" });
  await priceListItemsService.setPrice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId: priceList.id, productId: product.id, unitPriceMinor });
  await priceListsService.publish({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId: priceList.id });

  const order = await ordersService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "takeaway", currency: "PKR" });
  const item = await orderItemsService.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId: order.id, productId: product.id });
  return { orderId: order.id, itemId: item.id };
}

async function setMistakeReasonCode(tenant: Tenant): Promise<void> {
  await service.setReasonCode({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, code: "mistake", label: "Order entry mistake" });
}

describe("VoidsService.voidItem", () => {
  it("voids an unfired item with no approval needed", async () => {
    const tenant = await createRestaurant("void-unfired-ok");
    const branchId = await createBranch(tenant.restaurantId);
    await setMistakeReasonCode(tenant);
    const { orderId, itemId } = await createOpenOrderWithItem(tenant, branchId);

    const outcome = await service.voidItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, itemId, reasonCode: "mistake" });

    expect(outcome.requiredApproval).toBe(false);
    expect(outcome.approvedByUserId).toBeNull();

    const items = await orderItemsService.list(tenant.restaurantId, orderId);
    expect(items[0]?.voidedAt).not.toBeNull();
    expect(items[0]?.voidedByUserId).toBe(tenant.ownerUserId);
    expect(items[0]?.voidReasonCode).toBe("mistake");
    expect(items[0]?.voidApprovedByUserId).toBeNull();
  });

  it("requires manager approval once the item has been fired, and records who approved it", async () => {
    const tenant = await createRestaurant("void-fired-needs-approval");
    const branchId = await createBranch(tenant.restaurantId);
    await setMistakeReasonCode(tenant);
    const { orderId, itemId } = await createOpenOrderWithItem(tenant, branchId);
    const managerId = await createManager(tenant, "void-approver", "4321");
    await orderItemsService.fireItems({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, itemIds: [itemId] });

    await expect(
      service.voidItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, itemId, reasonCode: "mistake" }),
    ).rejects.toThrow(BadRequestException);

    const outcome = await service.voidItem({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.ownerUserId,
      orderId,
      itemId,
      reasonCode: "mistake",
      managerUserId: managerId,
      managerPin: "4321",
      stockDisposition: "wastage",
    });

    expect(outcome.requiredApproval).toBe(true);
    expect(outcome.approvedByUserId).toBe(managerId);

    const items = await orderItemsService.list(tenant.restaurantId, orderId);
    expect(items[0]?.voidApprovedByUserId).toBe(managerId);
  });

  it("rejects a wrong manager PIN on a fired item", async () => {
    const tenant = await createRestaurant("void-fired-wrong-pin");
    const branchId = await createBranch(tenant.restaurantId);
    await setMistakeReasonCode(tenant);
    const { orderId, itemId } = await createOpenOrderWithItem(tenant, branchId);
    const managerId = await createManager(tenant, "void-wrong-pin", "4321");
    await orderItemsService.fireItems({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, itemIds: [itemId] });

    await expect(
      service.voidItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, itemId, reasonCode: "mistake", managerUserId: managerId, managerPin: "0000", stockDisposition: "wastage" }),
    ).rejects.toThrow(ForbiddenException);
  });

  it("rejects voiding an already-voided item", async () => {
    const tenant = await createRestaurant("void-already-voided");
    const branchId = await createBranch(tenant.restaurantId);
    await setMistakeReasonCode(tenant);
    const { orderId, itemId } = await createOpenOrderWithItem(tenant, branchId);
    await service.voidItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, itemId, reasonCode: "mistake" });

    await expect(
      service.voidItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, itemId, reasonCode: "mistake" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects an unknown or inactive reason code", async () => {
    const tenant = await createRestaurant("void-bad-reason");
    const branchId = await createBranch(tenant.restaurantId);
    const { orderId, itemId } = await createOpenOrderWithItem(tenant, branchId);

    await expect(
      service.voidItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, itemId, reasonCode: "nonexistent" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects an item that doesn't belong to the order", async () => {
    const tenant = await createRestaurant("void-wrong-order");
    const branchId = await createBranch(tenant.restaurantId);
    await setMistakeReasonCode(tenant);
    const { itemId } = await createOpenOrderWithItem(tenant, branchId);
    const { orderId: orderB } = await createOpenOrderWithItem(tenant, branchId);

    await expect(
      service.voidItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId: orderB, itemId, reasonCode: "mistake" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("rejects voiding an item on an order that isn't open", async () => {
    const tenant = await createRestaurant("void-order-not-open");
    const branchId = await createBranch(tenant.restaurantId);
    await setMistakeReasonCode(tenant);
    const { orderId, itemId } = await createOpenOrderWithItem(tenant, branchId);
    await ordersService.close({ restaurantId: tenant.restaurantId, orderId, actorUserId: tenant.ownerUserId });

    await expect(
      service.voidItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, itemId, reasonCode: "mistake" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("a voided item is excluded from the order's computed total", async () => {
    const tenant = await createRestaurant("void-excluded-from-total");
    const branchId = await createBranch(tenant.restaurantId);
    await setMistakeReasonCode(tenant);
    const { orderId, itemId } = await createOpenOrderWithItem(tenant, branchId, 10_000n);

    await service.voidItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, itemId, reasonCode: "mistake" });

    const items = await orderItemsService.list(tenant.restaurantId, orderId);
    const total = computeOrderTotal(items, "PKR");
    expect(total.amountMinor).toBe(0n);
  });
});

describe("VoidsService reason codes", () => {
  it("lists reason codes, and setReasonCode upserts rather than duplicating", async () => {
    const tenant = await createRestaurant("void-reason-upsert");
    await service.setReasonCode({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, code: "spill", label: "Spilled" });
    await service.setReasonCode({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, code: "spill", label: "Spilled (updated)" });

    const codes = await service.listReasonCodes(tenant.restaurantId);
    expect(codes).toHaveLength(1);
    expect(codes[0]?.label).toBe("Spilled (updated)");
  });
});
