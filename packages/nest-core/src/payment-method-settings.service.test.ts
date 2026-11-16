import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { PaymentMethodSettingsService } from "./payment-method-settings.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: PaymentMethodSettingsService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  service = new PaymentMethodSettingsService(db, new AuditLogService(db));
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

describe("PaymentMethodSettingsService", () => {
  it("every method is enabled by default when nothing has been configured", async () => {
    const tenant = await createRestaurant("pm-default-enabled");
    expect(await service.isEnabled(tenant.restaurantId, "cash")).toBe(true);
    expect(await service.isEnabled(tenant.restaurantId, "wallet")).toBe(true);
    expect(await service.list(tenant.restaurantId)).toEqual([]);
  });

  it("disables a method, and lists it back", async () => {
    const tenant = await createRestaurant("pm-disable");
    await service.set({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, method: "wallet", enabled: false });

    expect(await service.isEnabled(tenant.restaurantId, "wallet")).toBe(false);
    expect(await service.isEnabled(tenant.restaurantId, "cash")).toBe(true);
    const list = await service.list(tenant.restaurantId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ method: "wallet", enabled: false });
  });

  it("re-enabling a previously disabled method upserts rather than creating a second row", async () => {
    const tenant = await createRestaurant("pm-reenable");
    await service.set({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, method: "card", enabled: false });
    await service.set({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, method: "card", enabled: true });

    expect(await service.isEnabled(tenant.restaurantId, "card")).toBe(true);
    const list = await service.list(tenant.restaurantId);
    expect(list).toHaveLength(1);
    expect(list[0]?.enabled).toBe(true);
  });

  it("a setting for one tenant never affects another tenant's defaults", async () => {
    const tenantA = await createRestaurant("pm-tenant-a");
    const tenantB = await createRestaurant("pm-tenant-b");
    await service.set({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, method: "bank_transfer", enabled: false });

    expect(await service.isEnabled(tenantA.restaurantId, "bank_transfer")).toBe(false);
    expect(await service.isEnabled(tenantB.restaurantId, "bank_transfer")).toBe(true);
  });

  it("audits every change", async () => {
    const tenant = await createRestaurant("pm-audit");
    const setting = await service.set({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, method: "cash", enabled: false });

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "payment_method_settings.disabled" && row.targetId === setting.id)).toBe(true);
  });
});
