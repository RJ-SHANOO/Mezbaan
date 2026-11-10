import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { ServiceChargeSettingsService } from "./service-charge-settings.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: ServiceChargeSettingsService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  service = new ServiceChargeSettingsService(db, new AuditLogService(db));
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

describe("ServiceChargeSettingsService", () => {
  it("creates a service charge setting, lists it, and audits the creation", async () => {
    const tenant = await createRestaurant("svc-create");
    const setting = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, rateBasisPoints: 1000 });

    expect(setting.isActive).toBe(true);
    expect(setting.isTaxable).toBe(false);
    const listed = await service.list(tenant.restaurantId);
    expect(listed.map((s) => s.id)).toContain(setting.id);

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "service_charge_setting.created" && row.targetId === setting.id)).toBe(true);
  });

  it("update rejects an unknown setting id", async () => {
    const tenant = await createRestaurant("svc-update-missing");
    await expect(
      service.update({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, serviceChargeSettingId: randomUUID(), isActive: false }),
    ).rejects.toThrow(NotFoundException);
  });

  describe("resolveApplicable", () => {
    it("picks the single most specifically-scoped active row, never summing multiple", async () => {
      const tenant = await createRestaurant("svc-resolve-specific");
      const branchId = await createBranch(tenant.restaurantId);
      await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, rateBasisPoints: 1000 });
      await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, rateBasisPoints: 500, branchId });

      const resolved = await service.resolveApplicable({ restaurantId: tenant.restaurantId, branchId, orderType: "dine_in" });
      expect(resolved?.rateBasisPoints).toBe(500);
    });

    it("returns null when no active setting matches the scope", async () => {
      const tenant = await createRestaurant("svc-resolve-none");
      const resolved = await service.resolveApplicable({ restaurantId: tenant.restaurantId, branchId: randomUUID(), orderType: "dine_in" });
      expect(resolved).toBeNull();
    });

    it("excludes an inactive setting", async () => {
      const tenant = await createRestaurant("svc-resolve-inactive");
      const setting = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, rateBasisPoints: 1000 });
      await service.update({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, serviceChargeSettingId: setting.id, isActive: false });

      const resolved = await service.resolveApplicable({ restaurantId: tenant.restaurantId, branchId: randomUUID(), orderType: "dine_in" });
      expect(resolved).toBeNull();
    });
  });
});
