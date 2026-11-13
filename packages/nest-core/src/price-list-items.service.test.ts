import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { CategoriesService } from "./categories.service.js";
import { ModifierGroupsService } from "./modifier-groups.service.js";
import { ModifierOptionsService } from "./modifier-options.service.js";
import { PriceListItemsService } from "./price-list-items.service.js";
import { PriceListsService } from "./price-lists.service.js";
import { ProductVariantsService } from "./product-variants.service.js";
import { ProductsService } from "./products.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: PriceListItemsService;
let priceListsService: PriceListsService;
let productsService: ProductsService;
let variantsService: ProductVariantsService;
let categoriesService: CategoriesService;
let modifierGroupsService: ModifierGroupsService;
let modifierOptionsService: ModifierOptionsService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  service = new PriceListItemsService(db, auditLogService);
  priceListsService = new PriceListsService(db, auditLogService);
  productsService = new ProductsService(db, auditLogService);
  variantsService = new ProductVariantsService(db, auditLogService);
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

async function createProduct(restaurantId: string, actorUserId: string): Promise<string> {
  const category = await categoriesService.create({ restaurantId, actorUserId, name: "Burgers" });
  const product = await productsService.create({ restaurantId, actorUserId, categoryId: category.id, name: "Cheeseburger" });
  return product.id;
}

async function createDraftPriceList(restaurantId: string, actorUserId: string): Promise<string> {
  const priceList = await priceListsService.create({ restaurantId, actorUserId, name: "Standard", currency: "PKR" });
  return priceList.id;
}

describe("PriceListItemsService", () => {
  it("sets a product price, lists it, and audits the set", async () => {
    const tenant = await createRestaurant("item-set-product");
    const priceListId = await createDraftPriceList(tenant.restaurantId, tenant.ownerUserId);
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);

    const item = await service.setPrice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId, productId, unitPriceMinor: 1500n });
    expect(item.unitPriceMinor).toBe(1500n);
    expect(item.variantId).toBeNull();

    const listed = await service.list(tenant.restaurantId, priceListId);
    expect(listed.map((i) => i.id)).toEqual([item.id]);

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "price_list_item.set" && row.targetId === priceListId)).toBe(true);
  });

  it("sets a variant price independently of its base product's price", async () => {
    const tenant = await createRestaurant("item-set-variant");
    const priceListId = await createDraftPriceList(tenant.restaurantId, tenant.ownerUserId);
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);
    const variant = await variantsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, productId, name: "Large" });

    await service.setPrice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId, productId, unitPriceMinor: 1500n });
    await service.setPrice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId, variantId: variant.id, unitPriceMinor: 1800n });

    const listed = await service.list(tenant.restaurantId, priceListId);
    expect(listed).toHaveLength(2);
    expect(listed.find((i) => i.variantId === variant.id)?.unitPriceMinor).toBe(1800n);
    expect(listed.find((i) => i.productId === productId)?.unitPriceMinor).toBe(1500n);
  });

  it("setting a price again for the same product updates the existing row instead of creating a duplicate", async () => {
    const tenant = await createRestaurant("item-upsert");
    const priceListId = await createDraftPriceList(tenant.restaurantId, tenant.ownerUserId);
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);

    await service.setPrice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId, productId, unitPriceMinor: 1500n });
    await service.setPrice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId, productId, unitPriceMinor: 1600n });

    const listed = await service.list(tenant.restaurantId, priceListId);
    expect(listed).toEqual([expect.objectContaining({ productId, unitPriceMinor: 1600n })]);
  });

  it("rejects setting a price with both productId and variantId, or with neither", async () => {
    const tenant = await createRestaurant("item-exactly-one");
    const priceListId = await createDraftPriceList(tenant.restaurantId, tenant.ownerUserId);
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);

    await expect(
      service.setPrice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId, productId, variantId: randomUUID(), unitPriceMinor: 100n }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.setPrice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId, unitPriceMinor: 100n }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("sets a modifier option's price independently of its product's price (P2-12)", async () => {
    const tenant = await createRestaurant("item-set-modifier-option");
    const priceListId = await createDraftPriceList(tenant.restaurantId, tenant.ownerUserId);
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);
    const group = await modifierGroupsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Toppings" });
    const option = await modifierOptionsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, modifierGroupId: group.id, name: "Extra Cheese" });

    await service.setPrice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId, productId, unitPriceMinor: 1500n });
    const modifierItem = await service.setPrice({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.ownerUserId,
      priceListId,
      modifierOptionId: option.id,
      unitPriceMinor: 150n,
    });
    expect(modifierItem.modifierOptionId).toBe(option.id);
    expect(modifierItem.productId).toBeNull();

    const listed = await service.list(tenant.restaurantId, priceListId);
    expect(listed.find((i) => i.modifierOptionId === option.id)?.unitPriceMinor).toBe(150n);
    expect(listed.find((i) => i.productId === productId)?.unitPriceMinor).toBe(1500n);
  });

  it("rejects setting a price for a modifier option from another tenant", async () => {
    const tenantA = await createRestaurant("item-cross-modifier-a");
    const tenantB = await createRestaurant("item-cross-modifier-b");
    const priceListIdA = await createDraftPriceList(tenantA.restaurantId, tenantA.ownerUserId);
    const groupB = await modifierGroupsService.create({ restaurantId: tenantB.restaurantId, actorUserId: tenantB.ownerUserId, name: "Toppings" });
    const optionB = await modifierOptionsService.create({ restaurantId: tenantB.restaurantId, actorUserId: tenantB.ownerUserId, modifierGroupId: groupB.id, name: "Extra Cheese" });

    await expect(
      service.setPrice({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, priceListId: priceListIdA, modifierOptionId: optionB.id, unitPriceMinor: 100n }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects setting a price for a product that belongs to a different tenant", async () => {
    const tenantA = await createRestaurant("item-cross-product-a");
    const tenantB = await createRestaurant("item-cross-product-b");
    const priceListIdA = await createDraftPriceList(tenantA.restaurantId, tenantA.ownerUserId);
    const productB = await createProduct(tenantB.restaurantId, tenantB.ownerUserId);

    await expect(
      service.setPrice({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, priceListId: priceListIdA, productId: productB, unitPriceMinor: 100n }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects changing items on a price list that's already published", async () => {
    const tenant = await createRestaurant("item-published-immutable");
    const priceListId = await createDraftPriceList(tenant.restaurantId, tenant.ownerUserId);
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);
    await service.setPrice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId, productId, unitPriceMinor: 1500n });
    await priceListsService.publish({ restaurantId: tenant.restaurantId, priceListId, actorUserId: tenant.ownerUserId });

    await expect(
      service.setPrice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId, productId, unitPriceMinor: 1600n }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("removes an item and audits it, and rejects removing on a published list", async () => {
    const tenant = await createRestaurant("item-remove");
    const priceListId = await createDraftPriceList(tenant.restaurantId, tenant.ownerUserId);
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);
    const item = await service.setPrice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId, productId, unitPriceMinor: 1500n });

    await service.removePrice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId, itemId: item.id });
    expect(await service.list(tenant.restaurantId, priceListId)).toEqual([]);

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "price_list_item.removed" && row.targetId === priceListId)).toBe(true);
  });

  it("throws NotFoundException removing an item that doesn't exist in this price list", async () => {
    const tenant = await createRestaurant("item-remove-not-found");
    const priceListId = await createDraftPriceList(tenant.restaurantId, tenant.ownerUserId);

    await expect(
      service.removePrice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId, itemId: randomUUID() }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
