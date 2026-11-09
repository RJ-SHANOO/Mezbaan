import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { ComboSlotsService } from "./combo-slots.service.js";
import { CombosService } from "./combos.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: ComboSlotsService;
let combosService: CombosService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  service = new ComboSlotsService(db, auditLogService);
  combosService = new CombosService(db, auditLogService);
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

async function createCombo(restaurantId: string, actorUserId: string): Promise<string> {
  const combo = await combosService.create({ restaurantId, actorUserId, name: "Burger Meal Deal" });
  return combo.id;
}

describe("ComboSlotsService", () => {
  it("creates a fixed slot, pinning minSelections/maxSelections to 1 regardless of what's passed", async () => {
    const tenant = await createRestaurant("slot-fixed-pin");
    const comboId = await createCombo(tenant.restaurantId, tenant.ownerUserId);

    const slot = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, comboId, name: "Side", kind: "fixed", minSelections: 5, maxSelections: 5 });

    expect(slot.minSelections).toBe(1);
    expect(slot.maxSelections).toBe(1);

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "combo_slot.created" && row.targetId === slot.id)).toBe(true);
  });

  it("creates a choice slot with its own min/max, lists it in sortOrder", async () => {
    const tenant = await createRestaurant("slot-choice-create");
    const comboId = await createCombo(tenant.restaurantId, tenant.ownerUserId);

    const drink = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, comboId, name: "Drink", kind: "choice", minSelections: 1, maxSelections: 1, sortOrder: 2 });
    const side = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, comboId, name: "Side", kind: "choice", sortOrder: 1 });

    const listed = await service.list(tenant.restaurantId, comboId);
    expect(listed.map((s) => s.id)).toEqual([side.id, drink.id]);
  });

  it("rejects creating a choice slot where maxSelections is lower than minSelections", async () => {
    const tenant = await createRestaurant("slot-choice-invalid-range");
    const comboId = await createCombo(tenant.restaurantId, tenant.ownerUserId);

    await expect(
      service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, comboId, name: "Side", kind: "choice", minSelections: 3, maxSelections: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects creating a slot under another tenant's combo", async () => {
    const tenantA = await createRestaurant("slot-cross-combo-a");
    const tenantB = await createRestaurant("slot-cross-combo-b");
    const comboB = await createCombo(tenantB.restaurantId, tenantB.ownerUserId);

    await expect(
      service.create({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, comboId: comboB, name: "Hijacked", kind: "fixed" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects updating a fixed slot's selection range — it's always exactly one", async () => {
    const tenant = await createRestaurant("slot-fixed-update-reject");
    const comboId = await createCombo(tenant.restaurantId, tenant.ownerUserId);
    const slot = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, comboId, name: "Side", kind: "fixed" });

    await expect(
      service.update({ restaurantId: tenant.restaurantId, slotId: slot.id, actorUserId: tenant.ownerUserId, maxSelections: 2 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("updates a choice slot's fields, leaving untouched fields as-is", async () => {
    const tenant = await createRestaurant("slot-choice-update");
    const comboId = await createCombo(tenant.restaurantId, tenant.ownerUserId);
    const slot = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, comboId, name: "Drink", kind: "choice" });

    const updated = await service.update({ restaurantId: tenant.restaurantId, slotId: slot.id, actorUserId: tenant.ownerUserId, maxSelections: 2 });
    expect(updated.maxSelections).toBe(2);
    expect(updated.name).toBe("Drink");
  });

  it("throws NotFoundException updating a slot id that belongs to a different tenant", async () => {
    const tenantA = await createRestaurant("slot-iso-update-a");
    const tenantB = await createRestaurant("slot-iso-update-b");
    const comboA = await createCombo(tenantA.restaurantId, tenantA.ownerUserId);
    const slot = await service.create({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, comboId: comboA, name: "Side", kind: "fixed" });

    await expect(
      service.update({ restaurantId: tenantB.restaurantId, slotId: slot.id, actorUserId: tenantB.ownerUserId, name: "Hijacked" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
