import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { CategoriesService } from "./categories.service.js";
import { PriceListItemsService } from "./price-list-items.service.js";
import { PriceListsService } from "./price-lists.service.js";
import { ProductsService } from "./products.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: PriceListsService;
let itemsService: PriceListItemsService;
let productsService: ProductsService;
let categoriesService: CategoriesService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  service = new PriceListsService(db, auditLogService);
  itemsService = new PriceListItemsService(db, auditLogService);
  productsService = new ProductsService(db, auditLogService);
  categoriesService = new CategoriesService(db, auditLogService);
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

describe("PriceListsService", () => {
  it("creates a draft price list, lists it, and audits the creation", async () => {
    const tenant = await createRestaurant("pl-create");
    const priceList = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Standard", currency: "PKR" });

    expect(priceList.status).toBe("draft");
    expect(priceList.version).toBe(1);

    const listed = await service.list(tenant.restaurantId);
    expect(listed.map((p) => p.id)).toContain(priceList.id);

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "price_list.created" && row.targetId === priceList.id)).toBe(true);
  });

  it("assigns sequential versions per (restaurant, name), independent of other names", async () => {
    const tenant = await createRestaurant("pl-version-seq");
    const v1 = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Standard", currency: "PKR" });
    const v2 = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Standard", currency: "PKR" });
    const happyHourV1 = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Happy Hour", currency: "PKR" });

    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(happyHourV1.version).toBe(1);
  });

  it("updates a draft's scope fields, leaving untouched fields as-is", async () => {
    const tenant = await createRestaurant("pl-update");
    const priceList = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Standard", currency: "PKR" });

    const updated = await service.update({ restaurantId: tenant.restaurantId, priceListId: priceList.id, actorUserId: tenant.ownerUserId, priority: 5 });
    expect(updated.priority).toBe(5);
    expect(updated.name).toBe("Standard");
  });

  it("rejects publishing an empty draft (no items)", async () => {
    const tenant = await createRestaurant("pl-publish-empty");
    const priceList = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Standard", currency: "PKR" });

    await expect(service.publish({ restaurantId: tenant.restaurantId, priceListId: priceList.id, actorUserId: tenant.ownerUserId })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("publishes a draft with at least one item, setting publishedAt", async () => {
    const tenant = await createRestaurant("pl-publish-ok");
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);
    const priceList = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Standard", currency: "PKR" });
    await itemsService.setPrice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId: priceList.id, productId, unitPriceMinor: 1500n });

    const published = await service.publish({ restaurantId: tenant.restaurantId, priceListId: priceList.id, actorUserId: tenant.ownerUserId });
    expect(published.status).toBe("published");
    expect(published.publishedAt).not.toBeNull();
  });

  it("rejects editing or publishing a price list that's already published", async () => {
    const tenant = await createRestaurant("pl-published-immutable");
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);
    const priceList = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Standard", currency: "PKR" });
    await itemsService.setPrice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId: priceList.id, productId, unitPriceMinor: 1500n });
    await service.publish({ restaurantId: tenant.restaurantId, priceListId: priceList.id, actorUserId: tenant.ownerUserId });

    await expect(
      service.update({ restaurantId: tenant.restaurantId, priceListId: priceList.id, actorUserId: tenant.ownerUserId, priority: 9 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.publish({ restaurantId: tenant.restaurantId, priceListId: priceList.id, actorUserId: tenant.ownerUserId })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("archives a published price list, and rejects archiving it a second time", async () => {
    const tenant = await createRestaurant("pl-archive");
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);
    const priceList = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Standard", currency: "PKR" });
    await itemsService.setPrice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId: priceList.id, productId, unitPriceMinor: 1500n });
    await service.publish({ restaurantId: tenant.restaurantId, priceListId: priceList.id, actorUserId: tenant.ownerUserId });

    const archived = await service.archive({ restaurantId: tenant.restaurantId, priceListId: priceList.id, actorUserId: tenant.ownerUserId });
    expect(archived.status).toBe("archived");

    await expect(service.archive({ restaurantId: tenant.restaurantId, priceListId: priceList.id, actorUserId: tenant.ownerUserId })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("a price list created under one tenant is never visible to another tenant's list()", async () => {
    const tenantA = await createRestaurant("pl-iso-a");
    const tenantB = await createRestaurant("pl-iso-b");
    await service.create({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, name: "A's List", currency: "PKR" });

    expect(await service.list(tenantB.restaurantId)).toEqual([]);
  });

  it("throws NotFoundException updating a price list id that belongs to a different tenant", async () => {
    const tenantA = await createRestaurant("pl-iso-update-a");
    const tenantB = await createRestaurant("pl-iso-update-b");
    const priceList = await service.create({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, name: "A's List", currency: "PKR" });

    await expect(
      service.update({ restaurantId: tenantB.restaurantId, priceListId: priceList.id, actorUserId: tenantB.ownerUserId, priority: 1 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
