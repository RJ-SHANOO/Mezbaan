import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createDb, createPool, schema, type Database } from "@mezbaan/db";
import { PermissionsService } from "./permissions.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: PermissionsService;
let cashierRoleId: string;

beforeAll(async () => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  service = new PermissionsService(db);

  const rows = await db
    .insert(schema.roles)
    .values({ key: "cashier", name: "Cashier" })
    .onConflictDoUpdate({ target: schema.roles.key, set: { name: "Cashier" } })
    .returning({ id: schema.roles.id });
  const row = rows[0];
  if (!row) throw new Error("fixture: cashier role insert returned no row");
  cashierRoleId = row.id;
});

afterAll(async () => {
  await pool.end();
});

async function grantPermission(roleId: string, permissionKey: string): Promise<void> {
  const permissionRows = await db
    .insert(schema.permissions)
    .values({ key: permissionKey, description: "test fixture" })
    .returning({ id: schema.permissions.id });
  const permission = permissionRows[0];
  if (!permission) throw new Error("fixture: permission insert returned no row");
  await db.insert(schema.rolePermissions).values({ roleId, permissionId: permission.id });
}

describe("PermissionsService.hasPermission()", () => {
  it("returns true when the role has been granted the permission", async () => {
    const permissionKey = `test.permission.${randomUUID()}`;
    await grantPermission(cashierRoleId, permissionKey);
    expect(await service.hasPermission("cashier", permissionKey)).toBe(true);
  });

  it("returns false when the permission exists but isn't granted to the role", async () => {
    const permissionKey = `test.permission.${randomUUID()}`;
    await db.insert(schema.permissions).values({ key: permissionKey, description: "test fixture, ungranted" });
    expect(await service.hasPermission("cashier", permissionKey)).toBe(false);
  });

  it("returns false for a permission key that doesn't exist at all", async () => {
    expect(await service.hasPermission("cashier", `nonexistent.${randomUUID()}`)).toBe(false);
  });

  it("returns false for a role key that doesn't exist", async () => {
    const permissionKey = `test.permission.${randomUUID()}`;
    await grantPermission(cashierRoleId, permissionKey);
    expect(await service.hasPermission("nonexistent-role", permissionKey)).toBe(false);
  });
});
