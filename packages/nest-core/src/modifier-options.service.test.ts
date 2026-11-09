import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { ModifierGroupsService } from "./modifier-groups.service.js";
import { ModifierOptionsService } from "./modifier-options.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: ModifierOptionsService;
let modifierGroupsService: ModifierGroupsService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  service = new ModifierOptionsService(db, auditLogService);
  modifierGroupsService = new ModifierGroupsService(db, auditLogService);
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

async function createGroup(restaurantId: string, actorUserId: string): Promise<string> {
  const group = await modifierGroupsService.create({ restaurantId, actorUserId, name: "Toppings" });
  return group.id;
}

describe("ModifierOptionsService", () => {
  it("creates an option under its group, lists it, and audits the creation", async () => {
    const tenant = await createRestaurant("option-create");
    const groupId = await createGroup(tenant.restaurantId, tenant.ownerUserId);

    const option = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, modifierGroupId: groupId, name: "Extra Cheese" });
    expect(option.status).toBe("active");

    const listed = await service.list(tenant.restaurantId, groupId);
    expect(listed.map((o) => o.id)).toContain(option.id);

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "modifier_option.created" && row.targetId === option.id)).toBe(true);
  });

  it("rejects creating an option under another tenant's modifier group", async () => {
    const tenantA = await createRestaurant("option-cross-a");
    const tenantB = await createRestaurant("option-cross-b");
    const groupB = await createGroup(tenantB.restaurantId, tenantB.ownerUserId);

    await expect(
      service.create({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, modifierGroupId: groupB, name: "Hijacked" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("updates an option's fields, leaving untouched fields as-is", async () => {
    const tenant = await createRestaurant("option-update");
    const groupId = await createGroup(tenant.restaurantId, tenant.ownerUserId);
    const option = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, modifierGroupId: groupId, name: "Extra Cheese" });

    const updated = await service.update({ restaurantId: tenant.restaurantId, optionId: option.id, actorUserId: tenant.ownerUserId, status: "inactive" });
    expect(updated.status).toBe("inactive");
    expect(updated.name).toBe("Extra Cheese");
  });

  it("throws NotFoundException updating an option id that belongs to a different tenant", async () => {
    const tenantA = await createRestaurant("option-iso-update-a");
    const tenantB = await createRestaurant("option-iso-update-b");
    const groupA = await createGroup(tenantA.restaurantId, tenantA.ownerUserId);
    const option = await service.create({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, modifierGroupId: groupA, name: "Extra Cheese" });

    await expect(
      service.update({ restaurantId: tenantB.restaurantId, optionId: option.id, actorUserId: tenantB.ownerUserId, name: "Hijacked" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
