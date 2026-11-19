import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { DeviceService } from "./device.service.js";
import { ShiftsService } from "./shifts.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: ShiftsService;
let deviceService: DeviceService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  deviceService = new DeviceService(db, auditLogService);
  service = new ShiftsService(db, auditLogService);
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

describe("ShiftsService.open", () => {
  it("opens a shift with the given float", async () => {
    const tenant = await createRestaurant("shift-open-ok");
    const branchId = await createBranch(tenant.restaurantId);
    const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });

    const shift = await service.open({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, deviceId: device.id, openingFloatMinor: 5_000n, currency: "PKR" });

    expect(shift.status).toBe("open");
    expect(shift.openingFloatMinor).toBe(5_000n);
    expect(shift.branchId).toBe(branchId);
  });

  it("rejects opening a second shift on a device that already has one open", async () => {
    const tenant = await createRestaurant("shift-open-twice");
    const branchId = await createBranch(tenant.restaurantId);
    const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
    await service.open({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, deviceId: device.id, openingFloatMinor: 5_000n, currency: "PKR" });

    await expect(
      service.open({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, deviceId: device.id, openingFloatMinor: 1_000n, currency: "PKR" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a negative opening float", async () => {
    const tenant = await createRestaurant("shift-open-negative");
    const branchId = await createBranch(tenant.restaurantId);
    const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });

    await expect(
      service.open({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, deviceId: device.id, openingFloatMinor: -1n, currency: "PKR" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects opening on a revoked device", async () => {
    const tenant = await createRestaurant("shift-open-revoked");
    const branchId = await createBranch(tenant.restaurantId);
    const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
    await deviceService.revoke({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, deviceId: device.id });

    await expect(
      service.open({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, deviceId: device.id, openingFloatMinor: 1_000n, currency: "PKR" }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe("ShiftsService.close", () => {
  it("sums the denomination counts into the counted cash total", async () => {
    const tenant = await createRestaurant("shift-close-ok");
    const branchId = await createBranch(tenant.restaurantId);
    const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
    const shift = await service.open({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, deviceId: device.id, openingFloatMinor: 5_000n, currency: "PKR" });

    const closed = await service.close({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.ownerUserId,
      shiftId: shift.id,
      denominationCounts: [
        { denominationMinor: 1_000n, count: 5 },
        { denominationMinor: 500n, count: 10 },
      ],
    });

    expect(closed.status).toBe("closed");
    expect(closed.countedCashMinor).toBe(10_000n);
    expect(closed.closingCashCounts).toHaveLength(2);
  });

  it("allows reopening the device once the previous shift is closed", async () => {
    const tenant = await createRestaurant("shift-reopen-ok");
    const branchId = await createBranch(tenant.restaurantId);
    const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
    const shift = await service.open({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, deviceId: device.id, openingFloatMinor: 5_000n, currency: "PKR" });
    await service.close({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, shiftId: shift.id, denominationCounts: [{ denominationMinor: 1_000n, count: 1 }] });

    const reopened = await service.open({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, deviceId: device.id, openingFloatMinor: 1_000n, currency: "PKR" });
    expect(reopened.status).toBe("open");
  });

  it("rejects closing an already-closed shift", async () => {
    const tenant = await createRestaurant("shift-close-twice");
    const branchId = await createBranch(tenant.restaurantId);
    const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
    const shift = await service.open({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, deviceId: device.id, openingFloatMinor: 5_000n, currency: "PKR" });
    await service.close({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, shiftId: shift.id, denominationCounts: [{ denominationMinor: 1_000n, count: 1 }] });

    await expect(
      service.close({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, shiftId: shift.id, denominationCounts: [{ denominationMinor: 1_000n, count: 1 }] }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects an empty denomination count list", async () => {
    const tenant = await createRestaurant("shift-close-empty");
    const branchId = await createBranch(tenant.restaurantId);
    const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
    const shift = await service.open({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, deviceId: device.id, openingFloatMinor: 5_000n, currency: "PKR" });

    await expect(service.close({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, shiftId: shift.id, denominationCounts: [] })).rejects.toThrow(BadRequestException);
  });

  it("rejects an unknown shift", async () => {
    const tenant = await createRestaurant("shift-unknown");
    await expect(
      service.close({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, shiftId: randomUUID(), denominationCounts: [{ denominationMinor: 1_000n, count: 1 }] }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe("ShiftsService.listForBranch", () => {
  it("paginates shifts newest-first with a cursor, with no gaps or duplicates across pages", async () => {
    const tenant = await createRestaurant("shift-list-pagination");
    const branchId = await createBranch(tenant.restaurantId);
    const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });

    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const shift = await service.open({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, deviceId: device.id, openingFloatMinor: 5_000n, currency: "PKR" });
      created.push(shift.id);
      await service.close({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, shiftId: shift.id, denominationCounts: [{ denominationMinor: 1_000n, count: 5 }] });
    }
    const newestFirst = [...created].reverse();

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 3; i++) {
      const page = await service.listForBranch(tenant.restaurantId, branchId, cursor, 2);
      seen.push(...page.items.map((s) => s.id));
      cursor = page.nextCursor ?? undefined;
      if (!page.nextCursor) break;
    }
    expect(seen).toEqual(newestFirst);
  });

  it("rejects a malformed pagination cursor", async () => {
    const tenant = await createRestaurant("shift-list-bad-cursor");
    const branchId = await createBranch(tenant.restaurantId);
    await expect(service.listForBranch(tenant.restaurantId, branchId, "not-a-real-cursor")).rejects.toThrow(BadRequestException);
  });
});
