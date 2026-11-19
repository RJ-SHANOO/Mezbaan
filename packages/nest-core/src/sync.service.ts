import { Inject, Injectable, Optional } from "@nestjs/common";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { OfflineSaleCompletedPayloadSchema, type SyncOperation, type SyncOperationResult } from "@mezbaan/contracts";
import { DATABASE } from "./db.module.js";
import { OfflineSaleSyncService } from "./offline-sale-sync.service.js";

export interface ReceiveBatchParams {
  restaurantId: string;
  branchId: string;
  deviceId: string;
  operations: SyncOperation[];
}

/**
 * The server side of P1-25's sync client. Processes one operation at a time
 * (not one bulk insert, since P2-45 added real per-operation-type business
 * writes) — each operation's sync_operations row insert and any business
 * write it triggers (e.g. OfflineSaleSyncService.process) run together in
 * one transaction, so a failed write leaves nothing partial behind: a retry
 * with the same idempotency_key just finds nothing recorded yet and tries
 * again from scratch (rule 9), the same guarantee P1-24's record_once gives
 * on the terminal side.
 *
 * ON CONFLICT DO NOTHING + RETURNING is how an already-recorded operation is
 * told apart from a genuinely new one: an empty RETURNING means a prior
 * attempt already committed (or a concurrent request on the same key won the
 * race), so this skips straight to "accepted" without re-running any
 * business write a second time.
 *
 * A structurally-valid operation of an unrecognized operationType is still
 * just stored and accepted, same as before P2-45 — "rejected" is for a
 * recognized type whose business write genuinely failed (e.g. P2-45's device
 * not yet configured with a default actor), which the Rust sync client
 * already knows to leave unsynced and retry later (P1-25/P2-45's own
 * "a_rejected_operation_stays_unsynced" test).
 */
@Injectable()
export class SyncService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Optional() private readonly offlineSaleSyncService?: OfflineSaleSyncService,
  ) {}

  async receiveBatch(params: ReceiveBatchParams): Promise<SyncOperationResult[]> {
    const results: SyncOperationResult[] = [];
    for (const op of params.operations) {
      try {
        await withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
          const inserted = await tx
            .insert(schema.syncOperations)
            .values({
              id: op.id,
              restaurantId: params.restaurantId,
              branchId: params.branchId,
              deviceId: params.deviceId,
              idempotencyKey: op.idempotencyKey,
              operationType: op.operationType,
              payload: op.payload,
            })
            .onConflictDoNothing({ target: [schema.syncOperations.restaurantId, schema.syncOperations.idempotencyKey] })
            .returning({ id: schema.syncOperations.id });

          if (inserted.length === 0) return; // already recorded — accepted, nothing new to process

          if (op.operationType === "offline_sale.completed" && this.offlineSaleSyncService) {
            const payload = OfflineSaleCompletedPayloadSchema.parse(JSON.parse(op.payload));
            await this.offlineSaleSyncService.process(tx, { restaurantId: params.restaurantId, branchId: params.branchId, deviceId: params.deviceId, payload });
          }
        });
        results.push({ id: op.id, status: "accepted" });
      } catch (error) {
        results.push({ id: op.id, status: "rejected", reason: error instanceof Error ? error.message : "processing failed" });
      }
    }
    return results;
  }
}
