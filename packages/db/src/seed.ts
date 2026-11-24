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
  { key: "pos.discount.approve", description: "Approve a discount above the restaurant's own-authority limit" },
  { key: "inventory.adjust", description: "Record a stock adjustment" },
  { key: "billing.refund.approve", description: "Approve a refund" },
  { key: "reports.view", description: "View sales and inventory reports" },
  { key: "settings.manage", description: "Manage restaurant/branch settings" },
  { key: "menu.manage", description: "Manage categories, products and branch availability" },
  { key: "pos.mark_out_of_stock", description: "Mark or clear a product or variant as out of stock (86) at a branch" },
  { key: "tables.manage", description: "Manage floors, tables and table QR codes" },
  { key: "credit.manage", description: "Create credit customers and set their credit limits" },
  { key: "business_day.manage", description: "Close a branch's business day" },
  { key: "kitchen.manage", description: "Manage kitchen stations and routing rules" },
  { key: "kitchen.view", description: "View kitchen tickets — no money fields are ever exposed through this permission" },
  { key: "inventory.manage", description: "Manage inventory categories, items and storage locations" },
  { key: "recipes.manage", description: "Define what a product or variant is made of" },
  { key: "suppliers.manage", description: "Manage supplier records, the items each supplies, and price history" },
  { key: "purchasing.manage", description: "Create and edit purchase orders, mark them sent" },
  { key: "purchasing.po.approve", description: "Approve a purchase order before it's sent to a supplier" },
  { key: "purchasing.receive", description: "Record a goods received note against a purchase order" },
  { key: "inventory.count.approve", description: "Approve a stock count's variance before stock is adjusted" },
  { key: "inventory.wastage.approve", description: "Approve a wastage entry above the restaurant's own-authority limit" },
] as const;

// Which seeded permissions each role gets by default. Kitchen staff gets none of these —
// kitchen APIs never carry money fields at all (rule 18), and kitchen-specific
// permissions (bump, recall, rush) arrive with the kitchen module in Phase 3. That same
// reasoning is why pos.mark_out_of_stock (P2-06) doesn't go to kitchen_staff either, even
// though kitchen screens are one of the task's two stated readers: there's no kitchen
// screen or kitchen-specific permission set for it to join yet. tables.manage (P2-07)
// goes to branch_manager, not settings.manage (branch CRUD/devices/invitations) — day to
// day floor-plan edits are an operational branch concern, same tier as menu.manage,
// not the org-structural tier settings.manage otherwise gates. kitchen.manage (P3-01)
// is station/routing setup, not the runtime bump/recall/rush permissions kitchen_staff
// will need once the kitchen screen (P3-03) exists — same tier and reasoning as
// tables.manage, still not granted to kitchen_staff. kitchen.view (P3-02) is the
// first permission kitchen_staff actually gets: read-only kitchen tickets, which
// KitchenTicketsService guarantees carry no money field at all (rule 18) — the
// reasoning that kept every earlier permission away from this role doesn't apply
// to a surface that structurally can't expose a price. inventory.manage (P3-07)
// is catalog/config setup for raw stock items, same tier as menu.manage/
// tables.manage/kitchen.manage — not the same permission as inventory.adjust
// (an operational stock-count correction, already seeded, different concern).
// recipes.manage (P3-13) is its own permission, not menu.manage or
// inventory.manage, because a recipe genuinely bridges both domains —
// overloading either existing permission would give it a meaning neither
// was designed for. suppliers.manage (P3-20) is the same tier again —
// purchasing setup, not an operational POS/kitchen permission.
// purchasing.manage (P3-21) is that same tier for purchase orders
// themselves; purchasing.po.approve is its own separate approval
// permission, same two-tier split as pos.discount.approve/pos.void.approve/
// billing.refund.approve — a draft PO's own creator doesn't get to also
// be the one who signs off on committing to it. purchasing.receive (P3-22)
// is its own permission again, not purchasing.manage — recording what a
// delivery driver actually dropped off is an operational, physical-receipt
// action, a different concern from managing the order document itself.
// inventory.count.approve (P3-27) is the same two-tier split again, same as
// pos.void.approve/billing.refund.approve/purchasing.po.approve — the person who
// started/submitted a stock count doesn't get to also be the one who approves its
// own variance before stock is adjusted. inventory.wastage.approve (P3-28) is the
// same own-authority-limit shape as pos.discount.approve, not an always-approve
// one like the others above — a small wastage entry within the restaurant's own
// configured limit is an ordinary action, same reasoning a credit sale within
// limit needs no approval either.
export const ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  super_admin: PERMISSION_SEED.map((p) => p.key),
  owner: PERMISSION_SEED.map((p) => p.key),
  branch_manager: [
    "pos.sell",
    "pos.void.approve",
    "pos.discount.approve",
    "billing.refund.approve",
    "inventory.adjust",
    "reports.view",
    "menu.manage",
    "pos.mark_out_of_stock",
    "tables.manage",
    "credit.manage",
    "business_day.manage",
    "kitchen.manage",
    "kitchen.view",
    "inventory.manage",
    "recipes.manage",
    "suppliers.manage",
    "purchasing.manage",
    "purchasing.po.approve",
    "purchasing.receive",
    "inventory.count.approve",
    "inventory.wastage.approve",
  ],
  cashier: ["pos.sell", "pos.mark_out_of_stock"],
  kitchen_staff: ["kitchen.view"],
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
