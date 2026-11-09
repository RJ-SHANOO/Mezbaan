import { Inject, Injectable } from "@nestjs/common";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE } from "./db.module.js";

export interface OutboxEntry {
  restaurantId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

/**
 * Writer side of P1-30's outbox. Section 5: "the outbox row is written in the
 * same transaction as the business change" — pass `tx` from inside the caller's
 * own withTenant transaction so the two commit (or roll back) together, same
 * convention as AuditLogService.record.
 */
@Injectable()
export class OutboxService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async record(entry: OutboxEntry, tx?: Database): Promise<void> {
    const values = {
      restaurantId: entry.restaurantId,
      aggregateType: entry.aggregateType,
      aggregateId: entry.aggregateId,
      eventType: entry.eventType,
      payload: entry.payload,
    };

    if (tx) {
      await tx.insert(schema.outbox).values(values);
      return;
    }
    await withTenant(this.db, { restaurantId: entry.restaurantId }, (txn) => txn.insert(schema.outbox).values(values));
  }
}
