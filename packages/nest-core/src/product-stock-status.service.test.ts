import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { CategoriesService } from "./categories.service.js";
import { ProductStockStatusService } from "./product-stock-status.service.js";
import { ProductVariantsService } from "./product-variants.service.js";
import { ProductsService } from "./products.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: ProductStockStatusService;
let categoriesService: CategoriesService;
let productsService: ProductsService;
let variantsService: ProductVariantsService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  service = new ProductStockStatusService(db, auditLogService);
  categoriesService = new CategoriesService(db, auditLogService);
  productsService = new ProductsService(db, auditLogService);
  variantsService = new ProductVariantsService(db, auditLogService);
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

describe("ProductStockStatusService", () => {
  it("marks a product out of stock, lists it, and audits the marking", async () => {
    const tenant = await createRestaurant("stock-mark");
    const branchId = await createBranch(tenant.restaurantId);
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);

    const marking = await service.markOutOfStock({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, productId, reason: "Ran out" });
    expect(marking.productId).toBe(productId);
    expect(marking.reason).toBe("Ran out");

    const listed = await service.list({ restaurantId: tenant.restaurantId, branchId });
    expect(listed.map((m) => m.id)).toEqual([marking.id]);

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "product_stock_status.marked" && row.targetId === marking.id)).toBe(true);
  });

  it("marking the same product/branch twice upserts rather than duplicating", async () => {
    const tenant = await createRestaurant("stock-upsert");
    const branchId = await createBranch(tenant.restaurantId);
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);

    const first = await service.markOutOfStock({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, productId, reason: "First" });
    const second = await service.markOutOfStock({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, productId, reason: "Second" });

    expect(second.id).toBe(first.id);
    expect(second.reason).toBe("Second");

    const listed = await service.list({ restaurantId: tenant.restaurantId, branchId });
    expect(listed).toHaveLength(1);
  });

  it("marks a variant out of stock independently of its bare product", async () => {
    const tenant = await createRestaurant("stock-variant");
    const branchId = await createBranch(tenant.restaurantId);
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);
    const variant = await variantsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, productId, name: "Large" });

    await service.markOutOfStock({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, variantId: variant.id });

    const listed = await service.list({ restaurantId: tenant.restaurantId, branchId });
    expect(listed).toEqual([expect.objectContaining({ productId: null, variantId: variant.id })]);
  });

  it("the same product can be 86'd at one branch and still in stock at another", async () => {
    const tenant = await createRestaurant("stock-per-branch");
    const branchA = await createBranch(tenant.restaurantId);
    const branchB = await createBranch(tenant.restaurantId);
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);

    await service.markOutOfStock({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId: branchA, productId });

    expect(await service.list({ restaurantId: tenant.restaurantId, branchId: branchA })).toHaveLength(1);
    expect(await service.list({ restaurantId: tenant.restaurantId, branchId: branchB })).toHaveLength(0);
  });

  it("clearing removes the marking, and clearing an unmarked item is rejected", async () => {
    const tenant = await createRestaurant("stock-clear");
    const branchId = await createBranch(tenant.restaurantId);
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);

    await service.markOutOfStock({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, productId });
    await service.clearOutOfStock({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, productId });

    expect(await service.list({ restaurantId: tenant.restaurantId, branchId })).toEqual([]);

    await expect(service.clearOutOfStock({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, productId })).rejects.toThrow(
      NotFoundException,
    );
  });

  it("rejects both productId and variantId set together, and rejects neither being set", async () => {
    const tenant = await createRestaurant("stock-exactly-one");
    const branchId = await createBranch(tenant.restaurantId);
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);

    await expect(
      service.markOutOfStock({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, productId, variantId: randomUUID() }),
    ).rejects.toThrow(BadRequestException);
    await expect(service.markOutOfStock({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId })).rejects.toThrow(BadRequestException);
  });

  it("rejects a product from another restaurant", async () => {
    const tenant = await createRestaurant("stock-cross-product");
    const otherTenant = await createRestaurant("stock-cross-product-other");
    const branchId = await createBranch(tenant.restaurantId);
    const otherProductId = await createProduct(otherTenant.restaurantId, otherTenant.ownerUserId);

    await expect(
      service.markOutOfStock({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, productId: otherProductId }),
    ).rejects.toThrow(NotFoundException);
  });
});
