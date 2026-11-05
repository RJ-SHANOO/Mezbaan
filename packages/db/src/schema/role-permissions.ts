import { pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import { permissions } from "./permissions.js";
import { roles } from "./roles.js";

/** Global join table: the default permissions each of the five roles gets. No RLS —
 * same reasoning as roles/permissions. */
export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permissionId] })],
);
