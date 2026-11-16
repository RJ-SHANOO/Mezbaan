import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { CashMovementsService } from "./cash-movements.service.js";
import { DeviceService } from "./device.service.js";
import { ShiftsService } from "./shifts.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: CashMovementsService;
let shiftsService: ShiftsService;
let deviceService: DeviceService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  deviceService = new DeviceService(db, auditLogService);
  shiftsService = new ShiftsService(db, auditLogService);
  service = new CashMovementsService(db, auditLogService);
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

async function createOpenShift(tenant: { restaurantId: string; ownerUserId: string }): Promise<string> {
  const branchRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) =>
    tx.insert(schema.branches).values({ restaurantId: tenant.restaurantId, name: "Main", timezone: "Asia/Karachi" }).returning({ id: schema.branches.id }),
  );
  const branchId = branchRows[0]?.id;
  if (!branchId) throw new Error("fixture: branch insert returned no row");
  const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
  const shift = await shiftsService.open({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, deviceId: device.id, openingFloatMinor: 5_000n, currency: "PKR" });
  return shift.id;
}

async function setPettyCashReasonCode(tenant: { restaurantId: string; ownerUserId: string }): Promise<void> {
  await service.setReasonCode({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, code: "petty_cash", label: "Petty cash payout" });
}

describe("CashMovementsService.recordCashIn/recordCashOut", () => {
  it("records a cash-in movement and an automatic drawer-open event", async () => {
    const tenant = await createRestaurant("cash-in-ok");
    await setPettyCashReasonCode(tenant);
    const shiftId = await createOpenShift(tenant);

    const movement = await service.recordCashIn({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, shiftId, amountMinor: 2_000n, reasonCode: "petty_cash" });
    expect(movement.direction).toBe("in");

    const events = await service.listDrawerOpenEventsForShift({ restaurantId: tenant.restaurantId, shiftId });
    expect(events.some((e) => e.trigger === "cash_in")).toBe(true);
  });

  it("records a cash-out movement", async () => {
    const tenant = await createRestaurant("cash-out-ok");
    await setPettyCashReasonCode(tenant);
    const shiftId = await createOpenShift(tenant);

    const movement = await service.recordCashOut({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, shiftId, amountMinor: 1_000n, reasonCode: "petty_cash" });
    expect(movement.direction).toBe("out");

    const movements = await service.listMovementsForShift({ restaurantId: tenant.restaurantId, shiftId });
    expect(movements).toHaveLength(1);
  });

  it("rejects a cash movement on a closed shift", async () => {
    const tenant = await createRestaurant("cash-closed-shift");
    await setPettyCashReasonCode(tenant);
    const shiftId = await createOpenShift(tenant);
    await shiftsService.close({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, shiftId, denominationCounts: [{ denominationMinor: 1_000n, count: 1 }] });

    await expect(
      service.recordCashIn({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, shiftId, amountMinor: 1_000n, reasonCode: "petty_cash" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects an unknown or inactive reason code", async () => {
    const tenant = await createRestaurant("cash-bad-reason");
    const shiftId = await createOpenShift(tenant);

    await expect(
      service.recordCashOut({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, shiftId, amountMinor: 1_000n, reasonCode: "nonexistent" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a non-positive amount", async () => {
    const tenant = await createRestaurant("cash-non-positive");
    await setPettyCashReasonCode(tenant);
    const shiftId = await createOpenShift(tenant);

    await expect(
      service.recordCashIn({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, shiftId, amountMinor: 0n, reasonCode: "petty_cash" }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe("CashMovementsService.logDrawerOpen", () => {
  it("logs a manual (e.g. no-sale) drawer-open event", async () => {
    const tenant = await createRestaurant("drawer-manual-open");
    const shiftId = await createOpenShift(tenant);

    const event = await service.logDrawerOpen({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, shiftId, trigger: "no_sale" });
    expect(event.trigger).toBe("no_sale");
  });
});
