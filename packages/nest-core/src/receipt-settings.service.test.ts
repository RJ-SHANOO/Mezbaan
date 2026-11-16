import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { ReceiptSettingsService } from "./receipt-settings.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: ReceiptSettingsService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  service = new ReceiptSettingsService(db, new AuditLogService(db));
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

describe("ReceiptSettingsService", () => {
  it("defaults to both breakdowns shown and no custom text when nothing's configured", async () => {
    const tenant = await createRestaurant("receipt-defaults");
    const settings = await service.get(tenant.restaurantId);
    expect(settings).toMatchObject({ logoUrl: null, headerText: null, footerText: null, showTaxBreakdown: true, showServiceCharge: true });
  });

  it("set upserts rather than duplicating, and only overwrites fields actually passed", async () => {
    const tenant = await createRestaurant("receipt-upsert");
    await service.set({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, footerText: "Thank you!", showTaxBreakdown: false });

    const afterFirst = await service.get(tenant.restaurantId);
    expect(afterFirst.footerText).toBe("Thank you!");
    expect(afterFirst.showTaxBreakdown).toBe(false);

    await service.set({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, headerText: "Mezbaan Grill" });

    const afterSecond = await service.get(tenant.restaurantId);
    expect(afterSecond.headerText).toBe("Mezbaan Grill");
    expect(afterSecond.footerText).toBe("Thank you!"); // untouched by the second call
    expect(afterSecond.showTaxBreakdown).toBe(false); // untouched by the second call
  });

  it("never leaks another restaurant's settings", async () => {
    const tenantA = await createRestaurant("receipt-iso-a");
    const tenantB = await createRestaurant("receipt-iso-b");
    await service.set({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, footerText: "A's footer" });

    const settingsB = await service.get(tenantB.restaurantId);
    expect(settingsB.footerText).toBeNull();
  });
});
