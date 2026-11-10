import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { FloorsService } from "./floors.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: FloorsService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  service = new FloorsService(db, new AuditLogService(db));
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

describe("FloorsService", () => {
  it("creates a floor, lists it, and audits the creation", async () => {
    const tenant = await createRestaurant("floor-create");
    const branchId = await createBranch(tenant.restaurantId);
    const floor = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, name: "Ground Floor" });

    const listed = await service.list(tenant.restaurantId, branchId);
    expect(listed.map((f) => f.id)).toContain(floor.id);

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "floor.created" && row.targetId === floor.id)).toBe(true);
  });

  it("rejects a branchId from another restaurant", async () => {
    const tenant = await createRestaurant("floor-cross");
    const otherTenant = await createRestaurant("floor-cross-other");
    const otherBranchId = await createBranch(otherTenant.restaurantId);

    await expect(
      service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId: otherBranchId, name: "Ground Floor" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("update rejects an unknown floor id", async () => {
    const tenant = await createRestaurant("floor-update-missing");
    await expect(service.update({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, floorId: randomUUID(), name: "New Name" })).rejects.toThrow(
      NotFoundException,
    );
  });

  it("lists only floors for the requested branch when a filter is given", async () => {
    const tenant = await createRestaurant("floor-filter");
    const branchA = await createBranch(tenant.restaurantId);
    const branchB = await createBranch(tenant.restaurantId);
    await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId: branchA, name: "A Floor" });
    await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId: branchB, name: "B Floor" });

    const listedA = await service.list(tenant.restaurantId, branchA);
    expect(listedA.map((f) => f.name)).toEqual(["A Floor"]);
  });
});
