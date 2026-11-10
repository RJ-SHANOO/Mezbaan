import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { TaxSettingsService } from "./tax-settings.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: TaxSettingsService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  service = new TaxSettingsService(db, new AuditLogService(db));
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

describe("TaxSettingsService", () => {
  it("defaults to exclusive pricing when nothing has been configured", async () => {
    const tenant = await createRestaurant("taxset-default");
    const branchId = await createBranch(tenant.restaurantId);
    expect(await service.resolvePricingMode(tenant.restaurantId, branchId)).toBe("exclusive");
  });

  it("set() is an upsert: calling it twice for the same scope replaces the mode, not duplicates the row", async () => {
    const tenant = await createRestaurant("taxset-upsert");
    await service.set({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, pricingMode: "inclusive" });
    await service.set({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, pricingMode: "exclusive" });

    const listed = await service.list(tenant.restaurantId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.pricingMode).toBe("exclusive");
  });

  it("a branch-specific setting overrides the restaurant-wide default for that branch only", async () => {
    const tenant = await createRestaurant("taxset-override");
    const branchId = await createBranch(tenant.restaurantId);
    const otherBranchId = await createBranch(tenant.restaurantId);

    await service.set({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, pricingMode: "exclusive" });
    await service.set({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, pricingMode: "inclusive" });

    expect(await service.resolvePricingMode(tenant.restaurantId, branchId)).toBe("inclusive");
    expect(await service.resolvePricingMode(tenant.restaurantId, otherBranchId)).toBe("exclusive");
  });

  it("rejects a branchId from another restaurant", async () => {
    const tenant = await createRestaurant("taxset-cross");
    const otherTenant = await createRestaurant("taxset-cross-other");
    const otherBranchId = await createBranch(otherTenant.restaurantId);

    await expect(
      service.set({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId: otherBranchId, pricingMode: "inclusive" }),
    ).rejects.toThrow(NotFoundException);
  });
});
