import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { CategoriesService } from "./categories.service.js";
import { ModifierGroupsService } from "./modifier-groups.service.js";
import { ModifierOptionsService } from "./modifier-options.service.js";
import { PriceListItemsService } from "./price-list-items.service.js";
import { PriceListsService, type CreatePriceListParams } from "./price-lists.service.js";
import { PriceResolutionService } from "./price-resolution.service.js";
import { ProductsService } from "./products.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: PriceResolutionService;
let priceListsService: PriceListsService;
let itemsService: PriceListItemsService;
let productsService: ProductsService;
let categoriesService: CategoriesService;
let modifierGroupsService: ModifierGroupsService;
let modifierOptionsService: ModifierOptionsService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  service = new PriceResolutionService(db);
  priceListsService = new PriceListsService(db, auditLogService);
  itemsService = new PriceListItemsService(db, auditLogService);
  productsService = new ProductsService(db, auditLogService);
  categoriesService = new CategoriesService(db, auditLogService);
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

async function createProduct(restaurantId: string, actorUserId: string): Promise<string> {
  const category = await categoriesService.create({ restaurantId, actorUserId, name: "Burgers" });
  const product = await productsService.create({ restaurantId, actorUserId, categoryId: category.id, name: "Cheeseburger" });
  return product.id;
}

async function publishPriceList(
  restaurantId: string,
  actorUserId: string,
  productId: string,
  unitPriceMinor: bigint,
  scope: Omit<CreatePriceListParams, "restaurantId" | "actorUserId" | "name" | "currency">,
): Promise<string> {
  const priceList = await priceListsService.create({ restaurantId, actorUserId, name: `List-${randomUUID()}`, currency: "PKR", ...scope });
  await itemsService.setPrice({ restaurantId, actorUserId, priceListId: priceList.id, productId, unitPriceMinor });
  await priceListsService.publish({ restaurantId, actorUserId, priceListId: priceList.id });
  return priceList.id;
}

describe("PriceResolutionService", () => {
  it("resolves the price from a universally-scoped published list (no branch/orderType restriction)", async () => {
    const tenant = await createRestaurant("resolve-universal");
    const branchId = await createBranch(tenant.restaurantId);
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);
    await publishPriceList(tenant.restaurantId, tenant.ownerUserId, productId, 1500n, {});

    const resolved = await service.resolvePrice({ restaurantId: tenant.restaurantId, branchId, orderType: "dine_in", productId });
    expect(resolved?.unitPriceMinor).toBe(1500n);
  });

  it("returns null when nothing matches at all", async () => {
    const tenant = await createRestaurant("resolve-nothing");
    const branchId = await createBranch(tenant.restaurantId);
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);

    expect(await service.resolvePrice({ restaurantId: tenant.restaurantId, branchId, orderType: "dine_in", productId })).toBeNull();
  });

  it("ignores a draft (unpublished) price list entirely", async () => {
    const tenant = await createRestaurant("resolve-ignores-draft");
    const branchId = await createBranch(tenant.restaurantId);
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);
    const draft = await priceListsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Draft", currency: "PKR" });
    await itemsService.setPrice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId: draft.id, productId, unitPriceMinor: 9999n });

    expect(await service.resolvePrice({ restaurantId: tenant.restaurantId, branchId, orderType: "dine_in", productId })).toBeNull();
  });

  it("a branch-scoped list only applies to that branch, not others", async () => {
    const tenant = await createRestaurant("resolve-branch-scope");
    const branchA = await createBranch(tenant.restaurantId);
    const branchB = await createBranch(tenant.restaurantId);
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);
    await publishPriceList(tenant.restaurantId, tenant.ownerUserId, productId, 2000n, { branchId: branchA });

    expect((await service.resolvePrice({ restaurantId: tenant.restaurantId, branchId: branchA, orderType: "dine_in", productId }))?.unitPriceMinor).toBe(2000n);
    expect(await service.resolvePrice({ restaurantId: tenant.restaurantId, branchId: branchB, orderType: "dine_in", productId })).toBeNull();
  });

  it("an order-type-scoped list only applies to that order type", async () => {
    const tenant = await createRestaurant("resolve-order-type-scope");
    const branchId = await createBranch(tenant.restaurantId);
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);
    await publishPriceList(tenant.restaurantId, tenant.ownerUserId, productId, 2200n, { orderType: "delivery" });

    expect((await service.resolvePrice({ restaurantId: tenant.restaurantId, branchId, orderType: "delivery", productId }))?.unitPriceMinor).toBe(2200n);
    expect(await service.resolvePrice({ restaurantId: tenant.restaurantId, branchId, orderType: "dine_in", productId })).toBeNull();
  });

  it("an effectiveFrom/effectiveTo window only applies inside that window", async () => {
    const tenant = await createRestaurant("resolve-time-window");
    const branchId = await createBranch(tenant.restaurantId);
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await publishPriceList(tenant.restaurantId, tenant.ownerUserId, productId, 1200n, {
      effectiveFrom: yesterday.toISOString(),
      effectiveTo: tomorrow.toISOString(),
    });

    expect((await service.resolvePrice({ restaurantId: tenant.restaurantId, branchId, orderType: "dine_in", productId, at: now }))?.unitPriceMinor).toBe(1200n);
    const lastYear = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    expect(await service.resolvePrice({ restaurantId: tenant.restaurantId, branchId, orderType: "dine_in", productId, at: lastYear })).toBeNull();
  });

  it("prefers the higher-priority list when two published lists both match", async () => {
    const tenant = await createRestaurant("resolve-priority-tiebreak");
    const branchId = await createBranch(tenant.restaurantId);
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);
    await publishPriceList(tenant.restaurantId, tenant.ownerUserId, productId, 1000n, { priority: 0 });
    await publishPriceList(tenant.restaurantId, tenant.ownerUserId, productId, 1300n, { priority: 10 });

    expect((await service.resolvePrice({ restaurantId: tenant.restaurantId, branchId, orderType: "dine_in", productId }))?.unitPriceMinor).toBe(1300n);
  });

  it("prefers the more specifically-scoped list over a universal one at equal priority", async () => {
    const tenant = await createRestaurant("resolve-specificity-tiebreak");
    const branchId = await createBranch(tenant.restaurantId);
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);
    await publishPriceList(tenant.restaurantId, tenant.ownerUserId, productId, 1000n, {}); // universal
    await publishPriceList(tenant.restaurantId, tenant.ownerUserId, productId, 1900n, { branchId }); // this branch specifically

    expect((await service.resolvePrice({ restaurantId: tenant.restaurantId, branchId, orderType: "dine_in", productId }))?.unitPriceMinor).toBe(1900n);
  });

  it("never resolves another tenant's price list", async () => {
    const tenantA = await createRestaurant("resolve-iso-a");
    const tenantB = await createRestaurant("resolve-iso-b");
    const branchB = await createBranch(tenantB.restaurantId);
    const productA = await createProduct(tenantA.restaurantId, tenantA.ownerUserId);
    await publishPriceList(tenantA.restaurantId, tenantA.ownerUserId, productA, 1500n, {});

    expect(await service.resolvePrice({ restaurantId: tenantB.restaurantId, branchId: branchB, orderType: "dine_in", productId: productA })).toBeNull();
  });

  it("rejects a query with both productId and variantId, or with neither", async () => {
    const tenant = await createRestaurant("resolve-exactly-one");
    const branchId = await createBranch(tenant.restaurantId);

    await expect(
      service.resolvePrice({ restaurantId: tenant.restaurantId, branchId, orderType: "dine_in", productId: randomUUID(), variantId: randomUUID() }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.resolvePrice({ restaurantId: tenant.restaurantId, branchId, orderType: "dine_in" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("resolves a modifier option's price independently of any product (P2-12)", async () => {
    const tenant = await createRestaurant("resolve-modifier-option");
    const branchId = await createBranch(tenant.restaurantId);
    const group = await modifierGroupsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Toppings" });
    const option = await modifierOptionsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, modifierGroupId: group.id, name: "Extra Cheese" });

    const priceList = await priceListsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: `List-${randomUUID()}`, currency: "PKR" });
    await itemsService.setPrice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId: priceList.id, modifierOptionId: option.id, unitPriceMinor: 150n });
    await priceListsService.publish({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId: priceList.id });

    const resolved = await service.resolvePrice({ restaurantId: tenant.restaurantId, branchId, orderType: "dine_in", modifierOptionId: option.id });
    expect(resolved?.unitPriceMinor).toBe(150n);
  });

  it("returns null for a modifier option with no price configured, rather than an error", async () => {
    const tenant = await createRestaurant("resolve-modifier-unpriced");
    const branchId = await createBranch(tenant.restaurantId);
    const group = await modifierGroupsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Preferences" });
    const option = await modifierOptionsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, modifierGroupId: group.id, name: "No Onions" });

    expect(await service.resolvePrice({ restaurantId: tenant.restaurantId, branchId, orderType: "dine_in", modifierOptionId: option.id })).toBeNull();
  });
});
