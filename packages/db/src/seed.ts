import { createDb, createPool, type Database } from "./client.js";
import { permissions, rolePermissions, roles } from "./schema/index.js";

export const DEFAULT_ADMIN_URL = "postgres://mezbaan:mezbaan_dev_password@localhost:5432/mezbaan";

export const ROLE_SEED = [
  { key: "super_admin", name: "Super Admin" },
  { key: "owner", name: "Restaurant Owner" },
  { key: "branch_manager", name: "Branch Manager" },
  { key: "cashier", name: "Cashier" },
  { key: "kitchen_staff", name: "Kitchen Staff" },
] as const;

export const PERMISSION_SEED = [
  { key: "pos.sell", description: "Ring up sales at the POS" },
  { key: "pos.void.approve", description: "Approve a void after kitchen firing" },
  { key: "inventory.adjust", description: "Record a stock adjustment" },
  { key: "billing.refund.approve", description: "Approve a refund" },
  { key: "reports.view", description: "View sales and inventory reports" },
  { key: "settings.manage", description: "Manage restaurant/branch settings" },
  { key: "menu.manage", description: "Manage categories, products and branch availability" },
  { key: "pos.mark_out_of_stock", description: "Mark or clear a product or variant as out of stock (86) at a branch" },
  { key: "tables.manage", description: "Manage floors, tables and table QR codes" },
] as const;

// Which seeded permissions each role gets by default. Kitchen staff gets none of these —
// kitchen APIs never carry money fields at all (rule 18), and kitchen-specific
// permissions (bump, recall, rush) arrive with the kitchen module in Phase 3. That same
// reasoning is why pos.mark_out_of_stock (P2-06) doesn't go to kitchen_staff either, even
// though kitchen screens are one of the task's two stated readers: there's no kitchen
// screen or kitchen-specific permission set for it to join yet. tables.manage (P2-07)
// goes to branch_manager, not settings.manage (branch CRUD/devices/invitations) — day to
// day floor-plan edits are an operational branch concern, same tier as menu.manage,
// not the org-structural tier settings.manage otherwise gates.
export const ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  super_admin: PERMISSION_SEED.map((p) => p.key),
  owner: PERMISSION_SEED.map((p) => p.key),
  branch_manager: ["pos.sell", "pos.void.approve", "inventory.adjust", "reports.view", "menu.manage", "pos.mark_out_of_stock", "tables.manage"],
  cashier: ["pos.sell", "pos.mark_out_of_stock"],
  kitchen_staff: [],
};

export interface SeedResult {
  roleCount: number;
  permissionCount: number;
  rolePermissionCount: number;
}

export async function runSeed(db: Database): Promise<SeedResult> {
  await db.insert(roles).values([...ROLE_SEED]).onConflictDoNothing({ target: roles.key });
  await db
    .insert(permissions)
    .values([...PERMISSION_SEED])
    .onConflictDoNothing({ target: permissions.key });

  const allRoles = await db.select().from(roles);
  const allPermissions = await db.select().from(permissions);
  const roleIdByKey = new Map<string, string>(allRoles.map((r) => [r.key, r.id]));
  const permissionIdByKey = new Map<string, string>(allPermissions.map((p) => [p.key, p.id]));

  const rolePermissionRows = Object.entries(ROLE_PERMISSIONS).flatMap(([roleKey, permissionKeys]) => {
    const roleId = roleIdByKey.get(roleKey);
    if (roleId === undefined) {
      throw new Error(`seed: role not found: ${roleKey}`);
    }
    return permissionKeys.map((permissionKey) => {
      const permissionId = permissionIdByKey.get(permissionKey);
      if (permissionId === undefined) {
        throw new Error(`seed: permission not found: ${permissionKey}`);
      }
      return { roleId, permissionId };
    });
  });

  if (rolePermissionRows.length > 0) {
    await db.insert(rolePermissions).values(rolePermissionRows).onConflictDoNothing();
  }

  return {
    roleCount: allRoles.length,
    permissionCount: allPermissions.length,
    rolePermissionCount: rolePermissionRows.length,
  };
}

export async function runSeedStandalone(connectionString: string = DEFAULT_ADMIN_URL): Promise<SeedResult> {
  const pool = createPool(connectionString);
  const db = createDb(pool);
  try {
    return await runSeed(db);
  } finally {
    await pool.end();
  }
}
