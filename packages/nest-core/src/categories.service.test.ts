import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { CategoriesService } from "./categories.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: CategoriesService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  service = new CategoriesService(db, new AuditLogService(db));
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

describe("CategoriesService", () => {
  it("creates a category, lists it in sortOrder, and audits the creation", async () => {
    const tenant = await createRestaurant("category-create");
    const beverages = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Beverages", sortOrder: 2 });
    const burgers = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Burgers", sortOrder: 1 });

    expect(beverages.status).toBe("active");
    expect(beverages.imageUrl).toBeNull();

    const listed = await service.list(tenant.restaurantId);
    expect(listed.map((c) => c.id)).toEqual([burgers.id, beverages.id]); // sortOrder 1 before 2

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "category.created" && row.targetId === beverages.id)).toBe(true);
  });

  it("updates a category's status and name, leaving untouched fields as-is", async () => {
    const tenant = await createRestaurant("category-update");
    const category = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Burgers" });

    const updated = await service.update({ restaurantId: tenant.restaurantId, categoryId: category.id, actorUserId: tenant.ownerUserId, status: "inactive" });
    expect(updated.status).toBe("inactive");
    expect(updated.name).toBe("Burgers");
  });

  it("a category created under one tenant is never visible to another tenant's list()", async () => {
    const tenantA = await createRestaurant("category-iso-a");
    const tenantB = await createRestaurant("category-iso-b");
    await service.create({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, name: "A's Category" });

    expect(await service.list(tenantB.restaurantId)).toEqual([]);
  });

  it("throws NotFoundException updating a category id that belongs to a different tenant", async () => {
    const tenantA = await createRestaurant("category-iso-update-a");
    const tenantB = await createRestaurant("category-iso-update-b");
    const category = await service.create({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, name: "A's Category" });

    await expect(
      service.update({ restaurantId: tenantB.restaurantId, categoryId: category.id, actorUserId: tenantB.ownerUserId, name: "Hijacked" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
