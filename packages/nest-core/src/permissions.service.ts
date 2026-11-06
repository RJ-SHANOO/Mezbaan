import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@mezbaan/db";
import { DATABASE } from "./db.module.js";

/**
 * roles/permissions/role_permissions are global reference tables (no RLS, no tenant
 * context needed — see packages/db/src/schema/roles.ts), so this queries the injected
 * Database directly rather than going through withTenant.
 */
// roles.key is a narrow literal union at the schema level (the five fixed roles); a
// roleKey arriving here is plain string (it came off a JWT claim), so it's cast back
// to that union for the comparison — never trusted beyond that, just compared.
type RoleKey = (typeof schema.roles.$inferSelect)["key"];

@Injectable()
export class PermissionsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async hasPermission(roleKey: string, permissionKey: string): Promise<boolean> {
    const rows = await this.db
      .select({ roleId: schema.rolePermissions.roleId })
      .from(schema.rolePermissions)
      .innerJoin(schema.roles, eq(schema.rolePermissions.roleId, schema.roles.id))
      .innerJoin(schema.permissions, eq(schema.rolePermissions.permissionId, schema.permissions.id))
      .where(and(eq(schema.roles.key, roleKey as RoleKey), eq(schema.permissions.key, permissionKey)));
    return rows.length > 0;
  }
}
