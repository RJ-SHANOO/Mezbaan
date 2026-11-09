import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { CategoriesService } from "./categories.service.js";
import { ProductVariantsService } from "./product-variants.service.js";
import { ProductsService } from "./products.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: ProductVariantsService;
let productsService: ProductsService;
let categoriesService: CategoriesService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  service = new ProductVariantsService(db, auditLogService);
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
  const category = await categoriesService.create({ restaurantId, actorUserId, name: "Pizzas" });
  const product = await productsService.create({ restaurantId, actorUserId, categoryId: category.id, name: "Margherita" });
  return product.id;
}

describe("ProductVariantsService", () => {
  it("creates a variant under its product, lists it in sortOrder, and audits the creation", async () => {
    const tenant = await createRestaurant("variant-create");
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);

    const large = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, productId, name: "Large", sortOrder: 2 });
    const small = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, productId, name: "Small", sortOrder: 1 });

    const listed = await service.list(tenant.restaurantId, productId);
    expect(listed.map((v) => v.id)).toEqual([small.id, large.id]);

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "product_variant.created" && row.targetId === large.id)).toBe(true);
  });

  it("rejects creating a variant under another tenant's product", async () => {
    const tenantA = await createRestaurant("variant-cross-a");
    const tenantB = await createRestaurant("variant-cross-b");
    const productB = await createProduct(tenantB.restaurantId, tenantB.ownerUserId);

    await expect(
      service.create({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, productId: productB, name: "Hijacked" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("updates a variant's fields, leaving untouched fields as-is", async () => {
    const tenant = await createRestaurant("variant-update");
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);
    const variant = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, productId, name: "Small" });

    const updated = await service.update({ restaurantId: tenant.restaurantId, variantId: variant.id, actorUserId: tenant.ownerUserId, status: "inactive", sku: "SM-001" });
    expect(updated.status).toBe("inactive");
    expect(updated.name).toBe("Small");
    expect(updated.sku).toBe("SM-001");
  });

  it("throws NotFoundException updating a variant id that belongs to a different tenant", async () => {
    const tenantA = await createRestaurant("variant-iso-update-a");
    const tenantB = await createRestaurant("variant-iso-update-b");
    const productA = await createProduct(tenantA.restaurantId, tenantA.ownerUserId);
    const variant = await service.create({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, productId: productA, name: "Small" });

    await expect(
      service.update({ restaurantId: tenantB.restaurantId, variantId: variant.id, actorUserId: tenantB.ownerUserId, name: "Hijacked" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("the restaurant+sku unique index rejects a real duplicate across variants", async () => {
    const tenant = await createRestaurant("variant-sku-unique");
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId);
    await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, productId, name: "Small", sku: "SKU-V1" });

    await expect(
      service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, productId, name: "Medium", sku: "SKU-V1" }),
    ).rejects.toThrow();
  });
});
