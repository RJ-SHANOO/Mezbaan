import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import { eq } from "drizzle-orm";
import { AuditLogService } from "./audit-log.service.js";
import { ManagerPinService } from "./manager-pin.service.js";
import { PermissionsService } from "./permissions.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let permissionsService: PermissionsService;
let auditLogService: AuditLogService;
let managerRoleId: string;
let cashierRoleId: string;

beforeAll(async () => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  permissionsService = new PermissionsService(db);
  auditLogService = new AuditLogService(db);

  const roleRows = await db
    .insert(schema.roles)
    .values([
      { key: "branch_manager", name: "Branch Manager" },
      { key: "cashier", name: "Cashier" },
    ])
    .onConflictDoUpdate({ target: schema.roles.key, set: { name: schema.roles.name } })
    .returning({ id: schema.roles.id, key: schema.roles.key });
  managerRoleId = roleRows.find((r) => r.key === "branch_manager")?.id ?? "";
  cashierRoleId = roleRows.find((r) => r.key === "cashier")?.id ?? "";
  if (!managerRoleId || !cashierRoleId) throw new Error("fixture: role insert returned no row");
});

afterAll(async () => {
  await pool.end();
});

interface Fixture {
  restaurantId: string;
  userId: string;
}

/** Grants a fresh, test-unique permission key to branch_manager only, and returns it —
 * mirrors permissions.service.test.ts's approach of not depending on seed.ts having
 * run, so this test is self-contained. */
async function grantManagerOnlyPermission(): Promise<string> {
  const permissionKey = `test.manager-pin.${randomUUID()}`;
  const rows = await db
    .insert(schema.permissions)
    .values({ key: permissionKey, description: "test fixture" })
    .returning({ id: schema.permissions.id });
  const permission = rows[0];
  if (!permission) throw new Error("fixture: permission insert returned no row");
  await db.insert(schema.rolePermissions).values({ roleId: managerRoleId, permissionId: permission.id });
  return permissionKey;
}

async function createUser(label: string, roleId: string): Promise<Fixture> {
  const restaurantRows = await withTenant(db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
    tx
      .insert(schema.restaurants)
      .values({ name: label, slug: `${label}-${randomUUID()}`, commissionRateBasisPoints: 500 })
      .returning({ id: schema.restaurants.id }),
  );
  const restaurant = restaurantRows[0];
  if (!restaurant) throw new Error("fixture: restaurant insert returned no row");

  const userRows = await withTenant(db, { restaurantId: restaurant.id }, (tx) =>
    tx
      .insert(schema.users)
      .values({
        restaurantId: restaurant.id,
        roleId,
        email: `${label}@example.test`,
        passwordHash: "unused-in-this-test",
        displayName: label,
      })
      .returning({ id: schema.users.id }),
  );
  const user = userRows[0];
  if (!user) throw new Error("fixture: user insert returned no row");

  return { restaurantId: restaurant.id, userId: user.id };
}

async function latestAuditAction(restaurantId: string, targetId: string): Promise<string | undefined> {
  const rows = await withTenant(db, { restaurantId }, (tx) =>
    tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.targetId, targetId)),
  );
  return rows.at(-1)?.action;
}

describe("ManagerPinService", () => {
  it("approves when the PIN is correct and the manager holds the required permission", async () => {
    const permissionKey = await grantManagerOnlyPermission();
    const service = new ManagerPinService(db, permissionsService, auditLogService, {});
    const manager = await createUser("approve-ok", managerRoleId);

    await service.setPin({ restaurantId: manager.restaurantId, userId: manager.userId, pin: "1234" });
    const result = await service.approve({
      restaurantId: manager.restaurantId,
      managerUserId: manager.userId,
      pin: "1234",
      requiredPermission: permissionKey,
      action: "void",
    });

    expect(result).toEqual({ approved: true });
    expect(await latestAuditAction(manager.restaurantId, "void")).toBe("void.approved");
  });

  it("rejects the wrong PIN and audits a denial", async () => {
    const permissionKey = await grantManagerOnlyPermission();
    const service = new ManagerPinService(db, permissionsService, auditLogService, {});
    const manager = await createUser("approve-wrong-pin", managerRoleId);
    await service.setPin({ restaurantId: manager.restaurantId, userId: manager.userId, pin: "1234" });

    await expect(
      service.approve({
        restaurantId: manager.restaurantId,
        managerUserId: manager.userId,
        pin: "0000",
        requiredPermission: permissionKey,
        action: "void",
      }),
    ).rejects.toThrow();
    expect(await latestAuditAction(manager.restaurantId, "void")).toBe("void.approval_denied");
  });

  it("rejects a user who holds no permission for the action, even with the correct PIN", async () => {
    const permissionKey = await grantManagerOnlyPermission();
    const service = new ManagerPinService(db, permissionsService, auditLogService, {});
    const cashier = await createUser("approve-no-permission", cashierRoleId);
    await service.setPin({ restaurantId: cashier.restaurantId, userId: cashier.userId, pin: "1234" });

    await expect(
      service.approve({
        restaurantId: cashier.restaurantId,
        managerUserId: cashier.userId,
        pin: "1234",
        requiredPermission: permissionKey,
        action: "void",
      }),
    ).rejects.toThrow();
  });

  it("rejects a manager who has never set a PIN", async () => {
    const permissionKey = await grantManagerOnlyPermission();
    const service = new ManagerPinService(db, permissionsService, auditLogService, {});
    const manager = await createUser("approve-no-pin-set", managerRoleId);

    await expect(
      service.approve({
        restaurantId: manager.restaurantId,
        managerUserId: manager.userId,
        pin: "1234",
        requiredPermission: permissionKey,
        action: "void",
      }),
    ).rejects.toThrow();
  });

  it("locks the PIN out after too many wrong attempts, even once the correct PIN is tried", async () => {
    const permissionKey = await grantManagerOnlyPermission();
    const service = new ManagerPinService(db, permissionsService, auditLogService, { maxFailedAttempts: 2 });
    const manager = await createUser("approve-lockout", managerRoleId);
    await service.setPin({ restaurantId: manager.restaurantId, userId: manager.userId, pin: "1234" });

    const wrongAttempt = () =>
      service.approve({
        restaurantId: manager.restaurantId,
        managerUserId: manager.userId,
        pin: "0000",
        requiredPermission: permissionKey,
        action: "void",
      });

    await expect(wrongAttempt()).rejects.toThrow();
    await expect(wrongAttempt()).rejects.toThrow(); // 2nd wrong attempt trips the lockout
    expect(await latestAuditAction(manager.restaurantId, "void")).toBe("void.approval_locked");

    await expect(
      service.approve({
        restaurantId: manager.restaurantId,
        managerUserId: manager.userId,
        pin: "1234",
        requiredPermission: permissionKey,
        action: "void",
      }),
    ).rejects.toThrow();
  });

  it("setPin resets an existing lockout", async () => {
    const permissionKey = await grantManagerOnlyPermission();
    const service = new ManagerPinService(db, permissionsService, auditLogService, { maxFailedAttempts: 1 });
    const manager = await createUser("setpin-resets-lockout", managerRoleId);
    await service.setPin({ restaurantId: manager.restaurantId, userId: manager.userId, pin: "1234" });

    await expect(
      service.approve({
        restaurantId: manager.restaurantId,
        managerUserId: manager.userId,
        pin: "wrong",
        requiredPermission: permissionKey,
        action: "void",
      }),
    ).rejects.toThrow(); // trips the lockout (maxFailedAttempts: 1)

    await service.setPin({ restaurantId: manager.restaurantId, userId: manager.userId, pin: "5678" });

    const result = await service.approve({
      restaurantId: manager.restaurantId,
      managerUserId: manager.userId,
      pin: "5678",
      requiredPermission: permissionKey,
      action: "void",
    });
    expect(result).toEqual({ approved: true });
  });

  it("rejects an approval naming a manager from a different restaurant", async () => {
    const permissionKey = await grantManagerOnlyPermission();
    const service = new ManagerPinService(db, permissionsService, auditLogService, {});
    const managerA = await createUser("cross-tenant-a", managerRoleId);
    const restaurantB = await createUser("cross-tenant-b", managerRoleId);
    await service.setPin({ restaurantId: managerA.restaurantId, userId: managerA.userId, pin: "1234" });

    await expect(
      service.approve({
        restaurantId: restaurantB.restaurantId,
        managerUserId: managerA.userId,
        pin: "1234",
        requiredPermission: permissionKey,
        action: "void",
      }),
    ).rejects.toThrow();
  });
});
