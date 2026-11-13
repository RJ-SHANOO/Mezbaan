import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { CategoriesService } from "./categories.service.js";
import { ModifierGroupsService } from "./modifier-groups.service.js";
import { ModifierOptionsService } from "./modifier-options.service.js";
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
let service: OrderItemsService;
let ordersService: OrdersService;
let categoriesService: CategoriesService;
let productsService: ProductsService;
let priceListsService: PriceListsService;
let priceListItemsService: PriceListItemsService;
let modifierGroupsService: ModifierGroupsService;
let modifierOptionsService: ModifierOptionsService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  const priceResolutionService = new PriceResolutionService(db);
  service = new OrderItemsService(db, auditLogService, priceResolutionService);
  ordersService = new OrdersService(db, auditLogService);
  categoriesService = new CategoriesService(db, auditLogService);
  productsService = new ProductsService(db, auditLogService);
  priceListsService = new PriceListsService(db, auditLogService);
  priceListItemsService = new PriceListItemsService(db, auditLogService);
  modifierGroupsService = new ModifierGroupsService(db, auditLogService);
  modifierOptionsService = new ModifierOptionsService(db, auditLogService);
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

async function createPricedProduct(restaurantId: string, actorUserId: string, unitPriceMinor: bigint): Promise<string> {
  const category = await categoriesService.create({ restaurantId, actorUserId, name: "Burgers" });
  const product = await productsService.create({ restaurantId, actorUserId, categoryId: category.id, name: "Cheeseburger" });
  const priceList = await priceListsService.create({ restaurantId, actorUserId, name: `List-${randomUUID()}`, currency: "PKR" });
  await priceListItemsService.setPrice({ restaurantId, actorUserId, priceListId: priceList.id, productId: product.id, unitPriceMinor });
  await priceListsService.publish({ restaurantId, actorUserId, priceListId: priceList.id });
  return product.id;
}

async function createOpenOrder(restaurantId: string, actorUserId: string, branchId: string): Promise<string> {
  const order = await ordersService.create({ restaurantId, actorUserId, branchId, orderType: "takeaway", currency: "PKR" });
  return order.id;
}

describe("OrderItemsService", () => {
  it("adds an item with a server-resolved price, lists it, and audits the add", async () => {
    const tenant = await createRestaurant("item-add-basic");
    const branchId = await createBranch(tenant.restaurantId);
    const productId = await createPricedProduct(tenant.restaurantId, tenant.ownerUserId, 1500n);
    const orderId = await createOpenOrder(tenant.restaurantId, tenant.ownerUserId, branchId);

    const item = await service.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, productId, quantity: 2, notes: "No onions" });
    expect(item.unitPriceMinor).toBe(1500n);
    expect(item.quantity).toBe(2);
    expect(item.notes).toBe("No onions");
    expect(item.modifiers).toEqual([]);

    const listed = await service.list(tenant.restaurantId, orderId);
    expect(listed.map((i) => i.id)).toEqual([item.id]);

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "order_item.added" && row.targetId === item.id)).toBe(true);
  });

  it("defaults quantity to 1 when not given", async () => {
    const tenant = await createRestaurant("item-default-quantity");
    const branchId = await createBranch(tenant.restaurantId);
    const productId = await createPricedProduct(tenant.restaurantId, tenant.ownerUserId, 1500n);
    const orderId = await createOpenOrder(tenant.restaurantId, tenant.ownerUserId, branchId);

    const item = await service.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, productId });
    expect(item.quantity).toBe(1);
  });

  it("rejects adding a product with no price configured for this branch/order type", async () => {
    const tenant = await createRestaurant("item-unpriced");
    const branchId = await createBranch(tenant.restaurantId);
    const category = await categoriesService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Burgers" });
    const product = await productsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, categoryId: category.id, name: "Cheeseburger" });
    const orderId = await createOpenOrder(tenant.restaurantId, tenant.ownerUserId, branchId);

    await expect(
      service.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, productId: product.id }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects adding to an order that doesn't exist, or one that's already closed", async () => {
    const tenant = await createRestaurant("item-order-state");
    const branchId = await createBranch(tenant.restaurantId);
    const productId = await createPricedProduct(tenant.restaurantId, tenant.ownerUserId, 1500n);

    await expect(
      service.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId: randomUUID(), productId }),
    ).rejects.toBeInstanceOf(NotFoundException);

    const orderId = await createOpenOrder(tenant.restaurantId, tenant.ownerUserId, branchId);
    await ordersService.close({ restaurantId: tenant.restaurantId, orderId, actorUserId: tenant.ownerUserId });
    await expect(
      service.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, productId }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects both productId and variantId set together, and rejects neither being set", async () => {
    const tenant = await createRestaurant("item-exactly-one");
    const branchId = await createBranch(tenant.restaurantId);
    const orderId = await createOpenOrder(tenant.restaurantId, tenant.ownerUserId, branchId);

    await expect(
      service.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, productId: randomUUID(), variantId: randomUUID() }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId })).rejects.toBeInstanceOf(BadRequestException);
  });

  describe("modifiers", () => {
    async function createProductWithModifierGroup(
      restaurantId: string,
      actorUserId: string,
      groupParams: { minSelections?: number; maxSelections?: number },
    ): Promise<{ productId: string; group: { id: string }; options: string[] }> {
      const productId = await createPricedProduct(restaurantId, actorUserId, 1500n);
      const group = await modifierGroupsService.create({ restaurantId, actorUserId, name: "Toppings", ...groupParams });
      const optionA = await modifierOptionsService.create({ restaurantId, actorUserId, modifierGroupId: group.id, name: "Extra Cheese" });
      const optionB = await modifierOptionsService.create({ restaurantId, actorUserId, modifierGroupId: group.id, name: "Bacon" });
      await withTenant(db, { restaurantId }, (tx) =>
        tx.insert(schema.productModifierGroups).values({ restaurantId, productId, modifierGroupId: group.id }),
      );
      return { productId, group, options: [optionA.id, optionB.id] };
    }

    it("adds an item with a priced modifier selection", async () => {
      const tenant = await createRestaurant("item-modifier-priced");
      const branchId = await createBranch(tenant.restaurantId);
      const { productId, options } = await createProductWithModifierGroup(tenant.restaurantId, tenant.ownerUserId, {});
      const priceList = await priceListsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: `ModList-${randomUUID()}`, currency: "PKR" });
      await priceListItemsService.setPrice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId: priceList.id, modifierOptionId: options[0]!, unitPriceMinor: 150n });
      await priceListsService.publish({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId: priceList.id });
      const orderId = await createOpenOrder(tenant.restaurantId, tenant.ownerUserId, branchId);

      const item = await service.addItem({
        restaurantId: tenant.restaurantId,
        actorUserId: tenant.ownerUserId,
        orderId,
        productId,
        modifierOptionIds: [options[0]!],
      });
      expect(item.modifiers).toHaveLength(1);
      expect(item.modifiers[0]?.unitPriceMinor).toBe(150n);
    });

    it("defaults an unpriced modifier to zero, using the item's own currency", async () => {
      const tenant = await createRestaurant("item-modifier-free");
      const branchId = await createBranch(tenant.restaurantId);
      const { productId, options } = await createProductWithModifierGroup(tenant.restaurantId, tenant.ownerUserId, {});
      const orderId = await createOpenOrder(tenant.restaurantId, tenant.ownerUserId, branchId);

      const item = await service.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, productId, modifierOptionIds: [options[0]!] });
      expect(item.modifiers[0]?.unitPriceMinor).toBe(0n);
      expect(item.modifiers[0]?.currency).toBe(item.currency);
    });

    it("rejects a modifier option that isn't offered on this product", async () => {
      const tenant = await createRestaurant("item-modifier-not-offered");
      const branchId = await createBranch(tenant.restaurantId);
      const { productId } = await createProductWithModifierGroup(tenant.restaurantId, tenant.ownerUserId, {});
      const otherGroup = await modifierGroupsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Sauces" });
      const otherOption = await modifierOptionsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, modifierGroupId: otherGroup.id, name: "Ketchup" });
      const orderId = await createOpenOrder(tenant.restaurantId, tenant.ownerUserId, branchId);

      await expect(
        service.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, productId, modifierOptionIds: [otherOption.id] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects too few selections for a required group, and too many for a capped one", async () => {
      const tenant = await createRestaurant("item-modifier-minmax");
      const branchId = await createBranch(tenant.restaurantId);
      const { productId, options } = await createProductWithModifierGroup(tenant.restaurantId, tenant.ownerUserId, { minSelections: 1, maxSelections: 1 });
      const orderId = await createOpenOrder(tenant.restaurantId, tenant.ownerUserId, branchId);

      await expect(
        service.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, productId, modifierOptionIds: [] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, productId, modifierOptionIds: options }),
      ).rejects.toBeInstanceOf(BadRequestException);

      const ok = await service.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, productId, modifierOptionIds: [options[0]!] });
      expect(ok.modifiers).toHaveLength(1);
    });

    it("rejects an unknown modifier option id", async () => {
      const tenant = await createRestaurant("item-modifier-unknown");
      const branchId = await createBranch(tenant.restaurantId);
      const { productId } = await createProductWithModifierGroup(tenant.restaurantId, tenant.ownerUserId, {});
      const orderId = await createOpenOrder(tenant.restaurantId, tenant.ownerUserId, branchId);

      await expect(
        service.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, productId, modifierOptionIds: [randomUUID()] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("updateItem / removeItem", () => {
    it("updates quantity, notes, seat and course", async () => {
      const tenant = await createRestaurant("item-update");
      const branchId = await createBranch(tenant.restaurantId);
      const productId = await createPricedProduct(tenant.restaurantId, tenant.ownerUserId, 1500n);
      const orderId = await createOpenOrder(tenant.restaurantId, tenant.ownerUserId, branchId);
      const item = await service.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, productId });

      const updated = await service.updateItem({
        restaurantId: tenant.restaurantId,
        actorUserId: tenant.ownerUserId,
        orderId,
        itemId: item.id,
        quantity: 3,
        notes: "Extra crispy",
        seatNumber: 2,
        course: "main",
      });
      expect(updated.quantity).toBe(3);
      expect(updated.notes).toBe("Extra crispy");
      expect(updated.seatNumber).toBe(2);
      expect(updated.course).toBe("main");
    });

    it("clears notes/seatNumber/course back to null", async () => {
      const tenant = await createRestaurant("item-clear-fields");
      const branchId = await createBranch(tenant.restaurantId);
      const productId = await createPricedProduct(tenant.restaurantId, tenant.ownerUserId, 1500n);
      const orderId = await createOpenOrder(tenant.restaurantId, tenant.ownerUserId, branchId);
      const item = await service.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, productId, notes: "No onions", seatNumber: 1, course: "main" });

      const updated = await service.updateItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, itemId: item.id, notes: null, seatNumber: null, course: null });
      expect(updated.notes).toBeNull();
      expect(updated.seatNumber).toBeNull();
      expect(updated.course).toBeNull();
    });

    it("removes an item (and its modifiers) and audits it", async () => {
      const tenant = await createRestaurant("item-remove");
      const branchId = await createBranch(tenant.restaurantId);
      const productId = await createPricedProduct(tenant.restaurantId, tenant.ownerUserId, 1500n);
      const orderId = await createOpenOrder(tenant.restaurantId, tenant.ownerUserId, branchId);
      const item = await service.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, productId });

      await service.removeItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, itemId: item.id });
      expect(await service.list(tenant.restaurantId, orderId)).toEqual([]);

      const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
      expect(auditRows.some((row) => row.action === "order_item.removed" && row.targetId === item.id)).toBe(true);
    });

    it("rejects updating or removing an item once the order is closed", async () => {
      const tenant = await createRestaurant("item-closed-order");
      const branchId = await createBranch(tenant.restaurantId);
      const productId = await createPricedProduct(tenant.restaurantId, tenant.ownerUserId, 1500n);
      const orderId = await createOpenOrder(tenant.restaurantId, tenant.ownerUserId, branchId);
      const item = await service.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, productId });
      await ordersService.close({ restaurantId: tenant.restaurantId, orderId, actorUserId: tenant.ownerUserId });

      await expect(
        service.updateItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, itemId: item.id, quantity: 2 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.removeItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, itemId: item.id }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("throws NotFoundException updating or removing an item that doesn't exist", async () => {
      const tenant = await createRestaurant("item-not-found");
      const branchId = await createBranch(tenant.restaurantId);
      const orderId = await createOpenOrder(tenant.restaurantId, tenant.ownerUserId, branchId);

      await expect(
        service.updateItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, itemId: randomUUID(), quantity: 2 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.removeItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, itemId: randomUUID() }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it("never lists another tenant's order items", async () => {
    const tenantA = await createRestaurant("item-iso-a");
    const tenantB = await createRestaurant("item-iso-b");
    const branchA = await createBranch(tenantA.restaurantId);
    const productA = await createPricedProduct(tenantA.restaurantId, tenantA.ownerUserId, 1500n);
    const orderA = await createOpenOrder(tenantA.restaurantId, tenantA.ownerUserId, branchA);
    await service.addItem({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, orderId: orderA, productId: productA });

    expect(await service.list(tenantB.restaurantId, orderA)).toEqual([]);
  });
});
