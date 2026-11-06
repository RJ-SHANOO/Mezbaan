import { Inject, Injectable } from "@nestjs/common";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE } from "./db.module.js";

export interface AuditLogEntry {
  restaurantId: string;
  branchId?: string | null;
  actorUserId?: string | null;
  deviceId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Append-only by convention (P1-13's minimal bootstrap of the full audit log, P1-14):
 * this service only ever inserts. There's no update()/delete() to misuse.
 */
@Injectable()
export class AuditLogService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Pass `tx` when recording from inside a caller's own withTenant transaction, so the
   * audit row commits atomically with whatever it's recording — rule 16 (never log
   * silently) plus never logging an action that itself got rolled back. */
  async record(entry: AuditLogEntry, tx?: Database): Promise<void> {
    const values = {
      restaurantId: entry.restaurantId,
      branchId: entry.branchId ?? null,
      actorUserId: entry.actorUserId ?? null,
      deviceId: entry.deviceId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata: entry.metadata ?? null,
    };

    if (tx) {
      await tx.insert(schema.auditLogs).values(values);
      return;
    }
    await withTenant(this.db, { restaurantId: entry.restaurantId }, (txn) => txn.insert(schema.auditLogs).values(values));
  }
}
