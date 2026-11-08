import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { BranchesService } from "./branches.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: BranchesService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  service = new BranchesService(db, new AuditLogService(db));
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

describe("BranchesService", () => {
  it("creates a branch, lists it, and audits the creation", async () => {
    const tenant = await createRestaurant("branch-create");
    const branch = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Main", timezone: "Asia/Karachi" });

    expect(branch.name).toBe("Main");
    expect(branch.status).toBe("active");

    const listed = await service.list(tenant.restaurantId);
    expect(listed.map((b) => b.id)).toContain(branch.id);

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "branch.created" && row.targetId === branch.id)).toBe(true);
  });

  it("assigns sequential branch numbers per restaurant, starting at 1 (P1-28)", async () => {
    const tenant = await createRestaurant("branch-number-seq");
    const first = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "First", timezone: "Asia/Karachi" });
    const second = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Second", timezone: "Asia/Karachi" });

    expect(first.branchNumber).toBe(1);
    expect(second.branchNumber).toBe(2);
  });

  it("numbers each restaurant's branches independently, both starting at 1", async () => {
    const tenantA = await createRestaurant("branch-number-iso-a");
    const tenantB = await createRestaurant("branch-number-iso-b");
    const branchA = await service.create({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, name: "A", timezone: "Asia/Karachi" });
    const branchB = await service.create({ restaurantId: tenantB.restaurantId, actorUserId: tenantB.ownerUserId, name: "B", timezone: "Asia/Karachi" });

    expect(branchA.branchNumber).toBe(1);
    expect(branchB.branchNumber).toBe(1);
  });

  it("the restaurant+branch_number UNIQUE index actually rejects a duplicate — the real rule-10 guarantee, not just the trigger's usual behavior", async () => {
    const tenant = await createRestaurant("branch-number-unique");
    const first = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "First", timezone: "Asia/Karachi" });

    await expect(
      withTenant(db, { restaurantId: tenant.restaurantId }, (tx) =>
        tx.insert(schema.branches).values({ restaurantId: tenant.restaurantId, name: "Duplicate", timezone: "Asia/Karachi", branchNumber: first.branchNumber }),
      ),
    ).rejects.toThrow();
  });

  it("updates a branch's status and audits it", async () => {
    const tenant = await createRestaurant("branch-update");
    const branch = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Main", timezone: "Asia/Karachi" });

    const updated = await service.update({
      restaurantId: tenant.restaurantId,
      branchId: branch.id,
      actorUserId: tenant.ownerUserId,
      status: "inactive",
    });
    expect(updated.status).toBe("inactive");
    expect(updated.name).toBe("Main"); // untouched fields stay as-is
  });

  it("a branch created under one tenant is never visible to another tenant's list()", async () => {
    const tenantA = await createRestaurant("branch-iso-a");
    const tenantB = await createRestaurant("branch-iso-b");
    await service.create({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, name: "A's Branch", timezone: "Asia/Karachi" });

    const seenByB = await service.list(tenantB.restaurantId);
    expect(seenByB).toEqual([]);
  });

  it("throws NotFoundException updating a branch id that belongs to a different tenant", async () => {
    const tenantA = await createRestaurant("branch-iso-update-a");
    const tenantB = await createRestaurant("branch-iso-update-b");
    const branch = await service.create({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, name: "A's Branch", timezone: "Asia/Karachi" });

    await expect(
      service.update({ restaurantId: tenantB.restaurantId, branchId: branch.id, actorUserId: tenantB.ownerUserId, name: "Hijacked" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws NotFoundException updating a branch id that doesn't exist at all", async () => {
    const tenant = await createRestaurant("branch-not-found");
    await expect(
      service.update({ restaurantId: tenant.restaurantId, branchId: randomUUID(), actorUserId: tenant.ownerUserId, name: "Nope" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
