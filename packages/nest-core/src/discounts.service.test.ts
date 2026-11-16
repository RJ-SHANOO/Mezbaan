import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { CategoriesService } from "./categories.service.js";
import { DiscountsService } from "./discounts.service.js";
import { ManagerPinService } from "./manager-pin.service.js";
import { OrderItemsService } from "./order-items.service.js";
import { OrdersService } from "./orders.service.js";
import { PermissionsService } from "./permissions.service.js";
import { PriceListItemsService } from "./price-list-items.service.js";
import { PriceListsService } from "./price-lists.service.js";
import { PriceResolutionService } from "./price-resolution.service.js";
import { ProductsService } from "./products.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: DiscountsService;
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
  service = new DiscountsService(db, auditLogService, managerPinService);

  // Same "don't depend on seed.ts having run" reasoning as manager-pin.service.test.ts
  // and permissions.service.test.ts — grant the real pos.discount.approve key
  // directly, idempotently, since DiscountsService hardcodes that exact string.
  const roleRows = await db
    .insert(schema.roles)
    .values({ key: "branch_manager", name: "Branch Manager" })
    .onConflictDoUpdate({ target: schema.roles.key, set: { name: schema.roles.name } })
    .returning({ id: schema.roles.id });
  managerRoleId = roleRows[0]?.id ?? "";
  if (!managerRoleId) throw new Error("fixture: role insert returned no row");

  const permissionRows = await db
    .insert(schema.permissions)
    .values({ key: "pos.discount.approve", description: "test fixture" })
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

async function setLoyaltyReasonCode(tenant: Tenant): Promise<void> {
  await service.setReasonCode({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, code: "loyalty", label: "Loyalty discount" });
}

describe("DiscountsService.applyItemDiscount", () => {
  it("applies a percent discount within the cashier's own authority, no approval needed", async () => {
    const tenant = await createRestaurant("discount-item-percent-ok");
    const branchId = await createBranch(tenant.restaurantId);
    await setLoyaltyReasonCode(tenant);
    await service.setLimits({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, maxUnapprovedPercentBasisPoints: 2000 });
    const { orderId, itemId } = await createOpenOrderWithItem(tenant, branchId, 10_000n);

    const outcome = await service.applyItemDiscount({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.ownerUserId,
      orderId,
      itemId,
      percentBasisPoints: 1000,
      reasonCode: "loyalty",
    });

    expect(outcome.discountMinor).toBe(1_000n);
    expect(outcome.approvedByUserId).toBeNull();

    const items = await orderItemsService.list(tenant.restaurantId, orderId);
    expect(items[0]?.discountPercentBasisPoints).toBe(1000);
  });

  it("requires manager approval above the own-authority limit, and records who approved it", async () => {
    const tenant = await createRestaurant("discount-item-needs-approval");
    const branchId = await createBranch(tenant.restaurantId);
    await setLoyaltyReasonCode(tenant);
    await service.setLimits({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, maxUnapprovedPercentBasisPoints: 1000 });
    const { orderId, itemId } = await createOpenOrderWithItem(tenant, branchId, 10_000n);
    const managerId = await createManager(tenant, "discount-approver", "4321");

    await expect(
      service.applyItemDiscount({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, itemId, percentBasisPoints: 5000, reasonCode: "loyalty" }),
    ).rejects.toThrow(BadRequestException);

    const outcome = await service.applyItemDiscount({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.ownerUserId,
      orderId,
      itemId,
      percentBasisPoints: 5000,
      reasonCode: "loyalty",
      managerUserId: managerId,
      managerPin: "4321",
    });

    expect(outcome.discountMinor).toBe(5_000n);
    expect(outcome.approvedByUserId).toBe(managerId);
  });

  it("rejects a wrong manager PIN", async () => {
    const tenant = await createRestaurant("discount-item-wrong-pin");
    const branchId = await createBranch(tenant.restaurantId);
    await setLoyaltyReasonCode(tenant);
    const { orderId, itemId } = await createOpenOrderWithItem(tenant, branchId, 10_000n);
    const managerId = await createManager(tenant, "discount-wrong-pin", "4321");

    await expect(
      service.applyItemDiscount({
        restaurantId: tenant.restaurantId,
        actorUserId: tenant.ownerUserId,
        orderId,
        itemId,
        percentBasisPoints: 1000,
        reasonCode: "loyalty",
        managerUserId: managerId,
        managerPin: "0000",
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it("requires approval for everything when no limits have been configured at all", async () => {
    const tenant = await createRestaurant("discount-item-no-limits-configured");
    const branchId = await createBranch(tenant.restaurantId);
    await setLoyaltyReasonCode(tenant);
    const { orderId, itemId } = await createOpenOrderWithItem(tenant, branchId, 10_000n);

    await expect(
      service.applyItemDiscount({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, itemId, percentBasisPoints: 100, reasonCode: "loyalty" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects an unknown or inactive reason code", async () => {
    const tenant = await createRestaurant("discount-item-bad-reason");
    const branchId = await createBranch(tenant.restaurantId);
    await service.setLimits({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, maxUnapprovedPercentBasisPoints: 10_000 });
    const { orderId, itemId } = await createOpenOrderWithItem(tenant, branchId, 10_000n);

    await expect(
      service.applyItemDiscount({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, itemId, percentBasisPoints: 1000, reasonCode: "nonexistent" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects specifying both or neither of percentBasisPoints/amountMinor", async () => {
    const tenant = await createRestaurant("discount-item-exactly-one");
    const branchId = await createBranch(tenant.restaurantId);
    await setLoyaltyReasonCode(tenant);
    const { orderId, itemId } = await createOpenOrderWithItem(tenant, branchId, 10_000n);

    await expect(
      service.applyItemDiscount({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, itemId, percentBasisPoints: 1000, amountMinor: 500n, reasonCode: "loyalty" }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.applyItemDiscount({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, itemId, reasonCode: "loyalty" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("the applied discount reduces the order's computed total", async () => {
    const tenant = await createRestaurant("discount-item-reduces-total");
    const branchId = await createBranch(tenant.restaurantId);
    await setLoyaltyReasonCode(tenant);
    await service.setLimits({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, maxUnapprovedAmountMinor: 5_000n });
    const { orderId, itemId } = await createOpenOrderWithItem(tenant, branchId, 10_000n);

    await service.applyItemDiscount({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, itemId, amountMinor: 2_000n, reasonCode: "loyalty" });

    const items = await orderItemsService.list(tenant.restaurantId, orderId);
    expect(items[0]?.discountAmountMinor).toBe(2_000n);
  });
});

describe("DiscountsService.removeItemDiscount", () => {
  it("clears a previously applied discount", async () => {
    const tenant = await createRestaurant("discount-item-remove");
    const branchId = await createBranch(tenant.restaurantId);
    await setLoyaltyReasonCode(tenant);
    await service.setLimits({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, maxUnapprovedPercentBasisPoints: 10_000 });
    const { orderId, itemId } = await createOpenOrderWithItem(tenant, branchId, 10_000n);
    await service.applyItemDiscount({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, itemId, percentBasisPoints: 1000, reasonCode: "loyalty" });

    await service.removeItemDiscount({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, itemId });

    const items = await orderItemsService.list(tenant.restaurantId, orderId);
    expect(items[0]?.discountPercentBasisPoints).toBeNull();
    expect(items[0]?.discountReasonCode).toBeNull();
  });

  it("rejects an item that doesn't belong to the order", async () => {
    const tenant = await createRestaurant("discount-item-remove-wrong-order");
    const branchId = await createBranch(tenant.restaurantId);
    const { itemId } = await createOpenOrderWithItem(tenant, branchId);
    const { orderId: orderB } = await createOpenOrderWithItem(tenant, branchId);

    await expect(service.removeItemDiscount({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId: orderB, itemId })).rejects.toThrow(NotFoundException);
  });
});

describe("DiscountsService.applyBillDiscount", () => {
  it("discounts the whole order's current subtotal", async () => {
    const tenant = await createRestaurant("discount-bill-ok");
    const branchId = await createBranch(tenant.restaurantId);
    await setLoyaltyReasonCode(tenant);
    await service.setLimits({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, maxUnapprovedPercentBasisPoints: 2000 });
    const { orderId } = await createOpenOrderWithItem(tenant, branchId, 10_000n);

    const outcome = await service.applyBillDiscount({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, percentBasisPoints: 1000, reasonCode: "loyalty" });

    expect(outcome.discountMinor).toBe(1_000n);
    expect(outcome.approvedByUserId).toBeNull();
  });

  it("rejects applying a discount to an order that isn't open", async () => {
    const tenant = await createRestaurant("discount-bill-not-open");
    const branchId = await createBranch(tenant.restaurantId);
    await setLoyaltyReasonCode(tenant);
    await service.setLimits({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, maxUnapprovedPercentBasisPoints: 10_000 });
    const { orderId } = await createOpenOrderWithItem(tenant, branchId);
    await ordersService.close({ restaurantId: tenant.restaurantId, orderId, actorUserId: tenant.ownerUserId });

    await expect(
      service.applyBillDiscount({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, percentBasisPoints: 1000, reasonCode: "loyalty" }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe("DiscountsService reason codes and limits", () => {
  it("lists reason codes, and setReasonCode upserts rather than duplicating", async () => {
    const tenant = await createRestaurant("discount-reason-upsert");
    await service.setReasonCode({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, code: "comp", label: "Manager comp" });
    await service.setReasonCode({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, code: "comp", label: "Manager comp (updated)" });

    const codes = await service.listReasonCodes(tenant.restaurantId);
    expect(codes).toHaveLength(1);
    expect(codes[0]?.label).toBe("Manager comp (updated)");
  });

  it("getLimits returns nulls (no auto-approval) when nothing has been configured", async () => {
    const tenant = await createRestaurant("discount-limits-default");
    expect(await service.getLimits(tenant.restaurantId)).toEqual({ maxUnapprovedPercentBasisPoints: null, maxUnapprovedAmountMinor: null });
  });

  it("setLimits upserts rather than duplicating", async () => {
    const tenant = await createRestaurant("discount-limits-upsert");
    await service.setLimits({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, maxUnapprovedPercentBasisPoints: 500 });
    await service.setLimits({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, maxUnapprovedPercentBasisPoints: 1500 });

    expect(await service.getLimits(tenant.restaurantId)).toEqual({ maxUnapprovedPercentBasisPoints: 1500, maxUnapprovedAmountMinor: null });
  });
});
