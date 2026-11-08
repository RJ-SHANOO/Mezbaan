import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import type { SnapshotContent, SyncSnapshotResponse } from "@mezbaan/contracts";
import { DATABASE } from "./db.module.js";
import { signBytes } from "./snapshot-signing.js";

/**
 * Downstream sync (P1-27): builds a versioned, signed snapshot of whatever a
 * terminal needs to keep working offline. Phase 1 scope only — staff (with each
 * manager's PIN hash, so P1-27b can verify one with no server round-trip) and
 * branches, the closest thing to "settings" that exists today. menu/prices have no
 * schema yet (Phase 2); this is where that section gets added once they do, not
 * something to redesign for.
 *
 * Signed over contentJson's exact bytes (see snapshot-signing.ts) so the client
 * verifies against the literal string it received — never a re-serialization of
 * the parsed object, which Rust and JS wouldn't promise byte-for-byte anyway.
 */
@Injectable()
export class SyncSnapshotService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async buildSnapshot(restaurantId: string): Promise<SyncSnapshotResponse> {
    const content = await this.loadContent(restaurantId);
    const contentJson = JSON.stringify(content);
    return {
      version: new Date().toISOString(),
      contentJson,
      signature: signBytes(contentJson),
    };
  }

  private async loadContent(restaurantId: string): Promise<SnapshotContent> {
    return withTenant(this.db, { restaurantId }, async (tx) => {
      const branches = await tx
        .select({ id: schema.branches.id, name: schema.branches.name, timezone: schema.branches.timezone, status: schema.branches.status })
        .from(schema.branches);

      const staff = await tx
        .select({
          id: schema.users.id,
          displayName: schema.users.displayName,
          email: schema.users.email,
          roleKey: schema.roles.key,
          branchId: schema.users.branchId,
          status: schema.users.status,
          pinHash: schema.managerPins.pinHash,
        })
        .from(schema.users)
        .innerJoin(schema.roles, eq(schema.users.roleId, schema.roles.id))
        .leftJoin(schema.managerPins, eq(schema.managerPins.userId, schema.users.id));

      return {
        restaurantId,
        branches,
        staff: staff.map((row) => ({ ...row, pinHash: row.pinHash ?? null })),
      };
    });
  }
}
