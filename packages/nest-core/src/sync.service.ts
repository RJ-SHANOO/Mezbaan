import { Inject, Injectable } from "@nestjs/common";
import { schema, withTenant, type Database } from "@mezbaan/db";
import type { SyncOperation, SyncOperationResult } from "@mezbaan/contracts";
import { DATABASE } from "./db.module.js";

export interface ReceiveBatchParams {
  restaurantId: string;
  branchId: string;
  deviceId: string;
  operations: SyncOperation[];
}

/**
 * The server side of P1-25's sync client. One bulk insert per batch, ON CONFLICT DO
 * NOTHING on (restaurant_id, idempotency_key) — rule 9: a retried batch (the client
 * crashed or timed out after this already committed) upserts nothing new, and every
 * operation in the request still gets "accepted" back, whether it was new or already
 * recorded. There's no business write to run per operation_type yet (orders/cart are
 * Phase 2), so every structurally valid operation is accepted; "rejected" exists in
 * the result shape for when there's an actual reason to use it.
 */
@Injectable()
export class SyncService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async receiveBatch(params: ReceiveBatchParams): Promise<SyncOperationResult[]> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      await tx
        .insert(schema.syncOperations)
        .values(
          params.operations.map((op) => ({
            id: op.id,
            restaurantId: params.restaurantId,
            branchId: params.branchId,
            deviceId: params.deviceId,
            idempotencyKey: op.idempotencyKey,
            operationType: op.operationType,
            payload: op.payload,
          })),
        )
        .onConflictDoNothing({ target: [schema.syncOperations.restaurantId, schema.syncOperations.idempotencyKey] });

      return params.operations.map((op) => ({ id: op.id, status: "accepted" as const }));
    });
  }
}
