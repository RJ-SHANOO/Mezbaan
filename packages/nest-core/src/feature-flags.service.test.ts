import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { FeatureFlagsService } from "./feature-flags.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: FeatureFlagsService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  service = new FeatureFlagsService(db, new AuditLogService(db));
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

describe("FeatureFlagsService", () => {
  it("has no flag rows for a module by default (absence means enabled)", async () => {
    const tenant = await createRestaurant("flags-default");
    const listed = await service.listForRestaurant(tenant.restaurantId);
    expect(listed).toEqual([]);
  });

  it("sets a flag, lists it back, and audits the change", async () => {
    const tenant = await createRestaurant("flags-set");
    const flag = await service.setFlag({
      restaurantId: tenant.restaurantId,
      moduleKey: "inventory",
      enabled: false,
      actorUserId: tenant.ownerUserId,
    });
    expect(flag.moduleKey).toBe("inventory");
    expect(flag.enabled).toBe(false);

    const listed = await service.listForRestaurant(tenant.restaurantId);
    expect(listed).toEqual([expect.objectContaining({ moduleKey: "inventory", enabled: false })]);

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "feature_flag.disabled" && row.targetId === flag.id)).toBe(true);
  });

  it("setting the same module twice upserts rather than creating a second row", async () => {
    const tenant = await createRestaurant("flags-upsert");
    await service.setFlag({ restaurantId: tenant.restaurantId, moduleKey: "kitchen", enabled: false, actorUserId: tenant.ownerUserId });
    await service.setFlag({ restaurantId: tenant.restaurantId, moduleKey: "kitchen", enabled: true, actorUserId: tenant.ownerUserId });

    const listed = await service.listForRestaurant(tenant.restaurantId);
    const kitchenRows = listed.filter((f) => f.moduleKey === "kitchen");
    expect(kitchenRows).toHaveLength(1);
    expect(kitchenRows[0]?.enabled).toBe(true);
  });

  it("a flag set for one restaurant is never visible in another restaurant's list", async () => {
    const tenantA = await createRestaurant("flags-iso-a");
    const tenantB = await createRestaurant("flags-iso-b");
    await service.setFlag({ restaurantId: tenantA.restaurantId, moduleKey: "inventory", enabled: false, actorUserId: tenantA.ownerUserId });

    const seenByB = await service.listForRestaurant(tenantB.restaurantId);
    expect(seenByB).toEqual([]);
  });

  it("a super-admin read can see a specific restaurant's flags by id", async () => {
    const tenant = await createRestaurant("flags-super-admin-read");
    await service.setFlag({ restaurantId: tenant.restaurantId, moduleKey: "reports", enabled: false, actorUserId: tenant.ownerUserId });

    const seen = await service.listForRestaurantAsSuperAdmin(tenant.restaurantId);
    expect(seen.map((f) => f.moduleKey)).toContain("reports");
  });
});
