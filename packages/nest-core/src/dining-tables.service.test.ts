import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { DiningTablesService } from "./dining-tables.service.js";
import { FloorsService } from "./floors.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: DiningTablesService;
let floorsService: FloorsService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  service = new DiningTablesService(db, auditLogService);
  floorsService = new FloorsService(db, auditLogService);
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

describe("DiningTablesService", () => {
  it("creates a table, derives branchId from the floor, and audits the creation", async () => {
    const tenant = await createRestaurant("table-create");
    const branchId = await createBranch(tenant.restaurantId);
    const floor = await floorsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, name: "Ground Floor" });

    const table = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, floorId: floor.id, name: "T1", seatCount: 4 });
    expect(table.branchId).toBe(branchId);
    expect(table.status).toBe("available");
    expect(table.qrToken).toContain(tenant.restaurantId);

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "dining_table.created" && row.targetId === table.id)).toBe(true);
  });

  it("defaults seatCount to 2 and leaves position unplaced when not given", async () => {
    const tenant = await createRestaurant("table-defaults");
    const branchId = await createBranch(tenant.restaurantId);
    const floor = await floorsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, name: "Ground Floor" });

    const table = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, floorId: floor.id, name: "T1" });
    expect(table.seatCount).toBe(2);
    expect(table.positionX).toBeNull();
    expect(table.positionY).toBeNull();
  });

  it("rejects a floorId from another restaurant", async () => {
    const tenant = await createRestaurant("table-cross-floor");
    const otherTenant = await createRestaurant("table-cross-floor-other");
    const otherBranchId = await createBranch(otherTenant.restaurantId);
    const otherFloor = await floorsService.create({ restaurantId: otherTenant.restaurantId, actorUserId: otherTenant.ownerUserId, branchId: otherBranchId, name: "Floor" });

    await expect(
      service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, floorId: otherFloor.id, name: "T1" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("updates status and position", async () => {
    const tenant = await createRestaurant("table-update");
    const branchId = await createBranch(tenant.restaurantId);
    const floor = await floorsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, name: "Ground Floor" });
    const table = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, floorId: floor.id, name: "T1" });

    const updated = await service.update({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.ownerUserId,
      tableId: table.id,
      status: "occupied",
      positionX: 120,
      positionY: 80,
    });
    expect(updated.status).toBe("occupied");
    expect(updated.positionX).toBe(120);
    expect(updated.positionY).toBe(80);
  });

  it("rejects moving a table to a floor in a different branch", async () => {
    const tenant = await createRestaurant("table-move-cross-branch");
    const branchA = await createBranch(tenant.restaurantId);
    const branchB = await createBranch(tenant.restaurantId);
    const floorA = await floorsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId: branchA, name: "A Floor" });
    const floorB = await floorsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId: branchB, name: "B Floor" });
    const table = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, floorId: floorA.id, name: "T1" });

    await expect(
      service.update({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, tableId: table.id, floorId: floorB.id }),
    ).rejects.toThrow(BadRequestException);
  });

  it("regenerateQrCode replaces the token", async () => {
    const tenant = await createRestaurant("table-regenerate");
    const branchId = await createBranch(tenant.restaurantId);
    const floor = await floorsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, name: "Ground Floor" });
    const table = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, floorId: floor.id, name: "T1" });

    const regenerated = await service.regenerateQrCode({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, tableId: table.id });
    expect(regenerated.qrToken).not.toBe(table.qrToken);

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "dining_table.qr_regenerated" && row.targetId === table.id)).toBe(true);
  });

  it("the branch+name UNIQUE index rejects a duplicate table name within the same branch", async () => {
    const tenant = await createRestaurant("table-dup-name");
    const branchId = await createBranch(tenant.restaurantId);
    const floor = await floorsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, name: "Ground Floor" });
    await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, floorId: floor.id, name: "T1" });

    await expect(service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, floorId: floor.id, name: "T1" })).rejects.toThrow();
  });
});
