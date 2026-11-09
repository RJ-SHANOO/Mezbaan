import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { CombosService } from "./combos.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: CombosService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  service = new CombosService(db, new AuditLogService(db));
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

describe("CombosService", () => {
  it("creates a combo, lists it, and audits the creation", async () => {
    const tenant = await createRestaurant("combo-create");
    const combo = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Burger Meal Deal" });

    expect(combo.status).toBe("active");
    const listed = await service.list(tenant.restaurantId);
    expect(listed.map((c) => c.id)).toContain(combo.id);

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "combo.created" && row.targetId === combo.id)).toBe(true);
  });

  it("updates a combo's fields, leaving untouched fields as-is", async () => {
    const tenant = await createRestaurant("combo-update");
    const combo = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Burger Meal Deal" });

    const updated = await service.update({ restaurantId: tenant.restaurantId, comboId: combo.id, actorUserId: tenant.ownerUserId, status: "inactive" });
    expect(updated.status).toBe("inactive");
    expect(updated.name).toBe("Burger Meal Deal");
  });

  it("a combo created under one tenant is never visible to another tenant's list()", async () => {
    const tenantA = await createRestaurant("combo-iso-a");
    const tenantB = await createRestaurant("combo-iso-b");
    await service.create({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, name: "A's Combo" });

    expect(await service.list(tenantB.restaurantId)).toEqual([]);
  });

  it("throws NotFoundException updating a combo id that belongs to a different tenant", async () => {
    const tenantA = await createRestaurant("combo-iso-update-a");
    const tenantB = await createRestaurant("combo-iso-update-b");
    const combo = await service.create({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, name: "A's Combo" });

    await expect(
      service.update({ restaurantId: tenantB.restaurantId, comboId: combo.id, actorUserId: tenantB.ownerUserId, name: "Hijacked" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
