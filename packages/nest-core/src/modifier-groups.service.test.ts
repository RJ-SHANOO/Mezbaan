import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { ModifierGroupsService } from "./modifier-groups.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: ModifierGroupsService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  service = new ModifierGroupsService(db, new AuditLogService(db));
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

describe("ModifierGroupsService", () => {
  it("creates a group with default min 0 (optional, uncapped) when nothing is specified", async () => {
    const tenant = await createRestaurant("group-create-default");
    const group = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Toppings" });

    expect(group.minSelections).toBe(0);
    expect(group.maxSelections).toBeNull();

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "modifier_group.created" && row.targetId === group.id)).toBe(true);
  });

  it("creates a required single-choice group (min 1, max 1)", async () => {
    const tenant = await createRestaurant("group-create-required");
    const group = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Sauce", minSelections: 1, maxSelections: 1 });

    expect(group.minSelections).toBe(1);
    expect(group.maxSelections).toBe(1);
  });

  it("rejects creating a group where maxSelections is lower than minSelections", async () => {
    const tenant = await createRestaurant("group-create-invalid-range");
    await expect(
      service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Bad", minSelections: 3, maxSelections: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("updates a group's fields, leaving untouched fields as-is", async () => {
    const tenant = await createRestaurant("group-update");
    const group = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Toppings" });

    const updated = await service.update({ restaurantId: tenant.restaurantId, modifierGroupId: group.id, actorUserId: tenant.ownerUserId, maxSelections: 3 });
    expect(updated.maxSelections).toBe(3);
    expect(updated.name).toBe("Toppings");
  });

  it("rejects an update that would make maxSelections lower than the (possibly unchanged) minSelections", async () => {
    const tenant = await createRestaurant("group-update-invalid-range");
    const group = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Sauce", minSelections: 2 });

    await expect(
      service.update({ restaurantId: tenant.restaurantId, modifierGroupId: group.id, actorUserId: tenant.ownerUserId, maxSelections: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("a group created under one tenant is never visible to another tenant's list()", async () => {
    const tenantA = await createRestaurant("group-iso-a");
    const tenantB = await createRestaurant("group-iso-b");
    await service.create({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, name: "A's Group" });

    expect(await service.list(tenantB.restaurantId)).toEqual([]);
  });

  it("throws NotFoundException updating a group id that belongs to a different tenant", async () => {
    const tenantA = await createRestaurant("group-iso-update-a");
    const tenantB = await createRestaurant("group-iso-update-b");
    const group = await service.create({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, name: "A's Group" });

    await expect(
      service.update({ restaurantId: tenantB.restaurantId, modifierGroupId: group.id, actorUserId: tenantB.ownerUserId, name: "Hijacked" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
