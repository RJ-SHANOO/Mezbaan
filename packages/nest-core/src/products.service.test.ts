import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { CategoriesService } from "./categories.service.js";
import { ProductsService } from "./products.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: ProductsService;
let categoriesService: CategoriesService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  service = new ProductsService(db, auditLogService);
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

async function createCategory(restaurantId: string, actorUserId: string, name = "Burgers"): Promise<string> {
  const category = await categoriesService.create({ restaurantId, actorUserId, name });
  return category.id;
}

async function createBranch(restaurantId: string): Promise<string> {
  const rows = await withTenant(db, { restaurantId }, (tx) =>
    tx.insert(schema.branches).values({ restaurantId, name: "Main", timezone: "Asia/Karachi" }).returning({ id: schema.branches.id }),
  );
  const branch = rows[0];
  if (!branch) throw new Error("fixture: branch insert returned no row");
  return branch.id;
}

describe("ProductsService", () => {
  it("creates a product under its category, lists it, and audits the creation", async () => {
    const tenant = await createRestaurant("product-create");
    const categoryId = await createCategory(tenant.restaurantId, tenant.ownerUserId);

    const product = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, categoryId, name: "Cheeseburger", sku: "BRG-001" });
    expect(product.status).toBe("active");
    expect(product.sku).toBe("BRG-001");
    expect(product.barcode).toBeNull();

    const listed = await service.list(tenant.restaurantId);
    expect(listed.map((p) => p.id)).toContain(product.id);

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "product.created" && row.targetId === product.id)).toBe(true);
  });

  it("lists only products in the given category when categoryId is passed", async () => {
    const tenant = await createRestaurant("product-filter");
    const burgers = await createCategory(tenant.restaurantId, tenant.ownerUserId, "Burgers");
    const drinks = await createCategory(tenant.restaurantId, tenant.ownerUserId, "Drinks");
    const burger = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, categoryId: burgers, name: "Cheeseburger" });
    await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, categoryId: drinks, name: "Cola" });

    const listed = await service.list(tenant.restaurantId, burgers);
    expect(listed.map((p) => p.id)).toEqual([burger.id]);
  });

  it("rejects creating a product with another tenant's categoryId — the FK alone wouldn't catch this (RLS doesn't protect FK checks)", async () => {
    const tenantA = await createRestaurant("product-cross-category-a");
    const tenantB = await createRestaurant("product-cross-category-b");
    const categoryB = await createCategory(tenantB.restaurantId, tenantB.ownerUserId);

    await expect(
      service.create({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, categoryId: categoryB, name: "Hijacked Product" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects updating a product's categoryId to another tenant's category", async () => {
    const tenantA = await createRestaurant("product-cross-category-update-a");
    const tenantB = await createRestaurant("product-cross-category-update-b");
    const categoryA = await createCategory(tenantA.restaurantId, tenantA.ownerUserId);
    const categoryB = await createCategory(tenantB.restaurantId, tenantB.ownerUserId);
    const product = await service.create({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, categoryId: categoryA, name: "Burger" });

    await expect(
      service.update({ restaurantId: tenantA.restaurantId, productId: product.id, actorUserId: tenantA.ownerUserId, categoryId: categoryB }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("updates a product's fields, leaving untouched fields as-is", async () => {
    const tenant = await createRestaurant("product-update");
    const categoryId = await createCategory(tenant.restaurantId, tenant.ownerUserId);
    const product = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, categoryId, name: "Burger" });

    const updated = await service.update({ restaurantId: tenant.restaurantId, productId: product.id, actorUserId: tenant.ownerUserId, status: "inactive", barcode: "1234567890" });
    expect(updated.status).toBe("inactive");
    expect(updated.name).toBe("Burger");
    expect(updated.barcode).toBe("1234567890");
  });

  it("a product created under one tenant is never visible to another tenant's list()", async () => {
    const tenantA = await createRestaurant("product-iso-a");
    const tenantB = await createRestaurant("product-iso-b");
    const categoryA = await createCategory(tenantA.restaurantId, tenantA.ownerUserId);
    await service.create({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, categoryId: categoryA, name: "A's Product" });

    expect(await service.list(tenantB.restaurantId)).toEqual([]);
  });

  it("the restaurant+sku unique index rejects a real duplicate, but two NULL skus never collide", async () => {
    const tenant = await createRestaurant("product-sku-unique");
    const categoryId = await createCategory(tenant.restaurantId, tenant.ownerUserId);
    await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, categoryId, name: "First", sku: "SKU-1" });
    await expect(service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, categoryId, name: "Duplicate", sku: "SKU-1" })).rejects.toThrow();

    // No sku on either — must not collide just because both are NULL.
    await expect(
      service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, categoryId, name: "No SKU A" }),
    ).resolves.toBeTruthy();
    await expect(
      service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, categoryId, name: "No SKU B" }),
    ).resolves.toBeTruthy();
  });

  describe("branch availability", () => {
    it("a product with no override is available everywhere by default — listBranchAvailability returns nothing", async () => {
      const tenant = await createRestaurant("availability-default");
      const categoryId = await createCategory(tenant.restaurantId, tenant.ownerUserId);
      const product = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, categoryId, name: "Burger" });

      expect(await service.listBranchAvailability(tenant.restaurantId, product.id)).toEqual([]);
    });

    it("sets an explicit override, which then shows up in listBranchAvailability", async () => {
      const tenant = await createRestaurant("availability-set");
      const categoryId = await createCategory(tenant.restaurantId, tenant.ownerUserId);
      const product = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, categoryId, name: "Burger" });
      const branchId = await createBranch(tenant.restaurantId);

      await service.setBranchAvailability({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, productId: product.id, branchId, available: false });

      expect(await service.listBranchAvailability(tenant.restaurantId, product.id)).toEqual([{ branchId, available: false }]);
    });

    it("setting availability again for the same product+branch updates the existing row instead of creating a duplicate", async () => {
      const tenant = await createRestaurant("availability-upsert");
      const categoryId = await createCategory(tenant.restaurantId, tenant.ownerUserId);
      const product = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, categoryId, name: "Burger" });
      const branchId = await createBranch(tenant.restaurantId);

      await service.setBranchAvailability({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, productId: product.id, branchId, available: false });
      await service.setBranchAvailability({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, productId: product.id, branchId, available: true });

      expect(await service.listBranchAvailability(tenant.restaurantId, product.id)).toEqual([{ branchId, available: true }]);
    });

    it("rejects setting availability for a branch that belongs to a different tenant", async () => {
      const tenantA = await createRestaurant("availability-cross-branch-a");
      const tenantB = await createRestaurant("availability-cross-branch-b");
      const categoryA = await createCategory(tenantA.restaurantId, tenantA.ownerUserId);
      const product = await service.create({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, categoryId: categoryA, name: "Burger" });
      const branchB = await createBranch(tenantB.restaurantId);

      await expect(
        service.setBranchAvailability({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, productId: product.id, branchId: branchB, available: false }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects setting availability for a product that belongs to a different tenant", async () => {
      const tenantA = await createRestaurant("availability-cross-product-a");
      const tenantB = await createRestaurant("availability-cross-product-b");
      const categoryA = await createCategory(tenantA.restaurantId, tenantA.ownerUserId);
      const productA = await service.create({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, categoryId: categoryA, name: "Burger" });
      const branchB = await createBranch(tenantB.restaurantId);

      await expect(
        service.setBranchAvailability({ restaurantId: tenantB.restaurantId, actorUserId: tenantB.ownerUserId, productId: productA.id, branchId: branchB, available: false }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
