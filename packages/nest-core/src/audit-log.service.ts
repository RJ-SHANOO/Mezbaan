import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { decodeCursor, seekCondition, toPage, type CursorFields, type Page } from "./cursor-pagination.js";
import { DATABASE } from "./db.module.js";
import { getTenantContext } from "./tenant-context.js";

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

export type AuditLogRecord = typeof schema.auditLogs.$inferSelect;

export interface ListAuditLogsParams {
  restaurantId: string;
  cursor?: string;
  limit?: number;
}

const DEFAULT_LIST_LIMIT = 50;

/**
 * Append-only by convention (P1-13's minimal bootstrap of the full audit log, P1-14):
 * this service only ever inserts. There's no update()/delete() to misuse.
 */
@Injectable()
export class AuditLogService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Pass `tx` when recording from inside a caller's own withTenant transaction, so the
   * audit row commits atomically with whatever it's recording — rule 16 (never log
   * silently) plus never logging an action that itself got rolled back.
   *
   * P3-40: `actingAsSuperAdmin` is read from the current request's own tenant
   * context (getTenantContext()), not accepted as a caller-supplied field — see
   * audit-logs.ts's own docs for why that's what makes this "full" logging
   * rather than something each call site could get wrong. Outside a request
   * (a background job calling this with no HTTP context at all, e.g.
   * CommissionRunService), getTenantContext() returns the anonymous context
   * and this correctly stamps false. */
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
      actingAsSuperAdmin: getTenantContext().isSuperAdmin,
    };

    if (tx) {
      await tx.insert(schema.auditLogs).values(values);
      return;
    }
    await withTenant(this.db, { restaurantId: entry.restaurantId }, (txn) => txn.insert(schema.auditLogs).values(values));
  }

  /** P3-40: the Super Admin's view of one restaurant's full audit trail —
   * cursor-paginated (P2-46 convention), since this table only ever grows,
   * one row per sensitive action for as long as the restaurant operates. */
  async listForRestaurantAsSuperAdmin(params: ListAuditLogsParams): Promise<Page<AuditLogRecord>> {
    const limit = params.limit ?? DEFAULT_LIST_LIMIT;
    const after: CursorFields | undefined = params.cursor !== undefined ? decodeCursor(params.cursor) : undefined;
    const rows = await withTenant(this.db, { restaurantId: params.restaurantId, isSuperAdmin: true }, (tx) =>
      tx
        .select()
        .from(schema.auditLogs)
        .where(and(eq(schema.auditLogs.restaurantId, params.restaurantId), seekCondition(schema.auditLogs.createdAt, schema.auditLogs.id, after)))
        .orderBy(desc(schema.auditLogs.createdAt), desc(schema.auditLogs.id))
        .limit(limit + 1),
    );
    return toPage(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  }
}
