import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE } from "./db.module.js";

export const OUTBOX_WORKER_OPTIONS = Symbol("OUTBOX_WORKER_OPTIONS");

export interface OutboxRecord {
  id: string;
  restaurantId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  attempts: number;
}

export type OutboxHandler = (record: OutboxRecord) => Promise<void>;

export interface OutboxWorkerOptions {
  /** One handler per eventType. An event with no registered handler fails the
   * same way a handler that throws does — it retries with backoff, then
   * dead-letters — since a missing handler is a real configuration gap, not
   * something to skip silently (rule 16). */
  handlers?: Record<string, OutboxHandler>;
  /** Only the worker process (apps/worker) should actually run the polling
   * loop — every other process that imports OutboxModule just wants
   * OutboxService to write rows in its own transactions. Defaults to false for
   * that reason. */
  autoStart?: boolean;
  pollIntervalMs?: number;
  batchSize?: number;
}

export interface OutboxBatchSummary {
  claimed: number;
  succeeded: number;
  retried: number;
  deadLettered: number;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 20;
const MAX_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60 * 1_000;

/** `attempts` is 1-based (the attempt that just failed). Doubles each attempt,
 * capped at MAX_BACKOFF_MS — mirrors sync_client.rs's backoff_duration. */
function backoffMs(attempts: number): number {
  const factor = 2 ** Math.min(Math.max(attempts - 1, 0), 10);
  return Math.min(INITIAL_BACKOFF_MS * factor, MAX_BACKOFF_MS);
}

/**
 * P1-30: polls the outbox table directly with no broker in between (Redpanda is
 * a later/separate concern — Phase 4) — that's this task's literal requirement.
 * Safe to run as more than one instance (section 5: "each process runs at least
 * two instances"): claiming a batch uses `SELECT ... FOR UPDATE SKIP LOCKED`
 * inside its own transaction, so two worker instances polling at once never both
 * claim the same row.
 *
 * There's no real producer yet (every actual business write is Phase 2+), so
 * this is exercised with synthetic handlers in tests — same situation
 * operation_log (P1-24) and the sync client (P1-25) were in before their real
 * callers existed.
 */
@Injectable()
export class OutboxWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorkerService.name);
  private readonly handlers: Record<string, OutboxHandler>;
  private readonly autoStart: boolean;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX_WORKER_OPTIONS) options: OutboxWorkerOptions,
  ) {
    this.handlers = options.handlers ?? {};
    this.autoStart = options.autoStart ?? false;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  onModuleInit(): void {
    if (!this.autoStart) return;
    this.scheduleNextPoll();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private scheduleNextPoll(): void {
    this.timer = setTimeout(() => {
      this.processBatch()
        .catch((error: unknown) => {
          // Rule 14: a background job failure must never crash or block anything
          // else — log with context and keep polling.
          this.logger.error(`outbox poll cycle failed: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          if (!this.stopped) this.scheduleNextPoll();
        });
    }, this.pollIntervalMs);
  }

  /** One claim-and-process cycle. Exposed directly (not just via the internal
   * poll loop) so callers — and tests — can drive it deterministically instead
   * of waiting on a timer. */
  async processBatch(now: Date = new Date()): Promise<OutboxBatchSummary> {
    const claimed = await this.claimBatch(now);
    const summary: OutboxBatchSummary = { claimed: claimed.length, succeeded: 0, retried: 0, deadLettered: 0 };

    for (const record of claimed) {
      try {
        const handler = this.handlers[record.eventType];
        if (!handler) throw new Error(`no outbox handler registered for event type "${record.eventType}"`);
        await handler(record);
        await this.markProcessed(record.id);
        summary.succeeded += 1;
      } catch (error) {
        const attempts = record.attempts + 1;
        const message = error instanceof Error ? error.message : String(error);
        if (attempts >= MAX_ATTEMPTS) {
          this.logger.error(`outbox event ${record.id} (${record.eventType}) dead-lettered after ${attempts} attempts: ${message}`);
          await this.markDeadLetter(record.id, attempts, message);
          summary.deadLettered += 1;
        } else {
          this.logger.warn(`outbox event ${record.id} (${record.eventType}) failed attempt ${attempts}: ${message}`);
          await this.markFailedForRetry(record.id, attempts, message, now);
          summary.retried += 1;
        }
      }
    }
    return summary;
  }

  private async claimBatch(now: Date): Promise<OutboxRecord[]> {
    return withTenant(this.db, { restaurantId: null, isSuperAdmin: true }, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.outbox)
        .where(and(eq(schema.outbox.status, "pending"), lte(schema.outbox.availableAt, now)))
        .orderBy(asc(schema.outbox.createdAt))
        .limit(this.batchSize)
        .for("update", { skipLocked: true });

      if (rows.length === 0) return [];

      const ids = rows.map((row) => row.id);
      await tx.update(schema.outbox).set({ status: "processing" }).where(inArray(schema.outbox.id, ids));

      return rows.map((row) => ({
        id: row.id,
        restaurantId: row.restaurantId,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        eventType: row.eventType,
        payload: row.payload,
        attempts: row.attempts,
      }));
    });
  }

  private async markProcessed(id: string): Promise<void> {
    await withTenant(this.db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
      tx.update(schema.outbox).set({ status: "processed", processedAt: new Date() }).where(eq(schema.outbox.id, id)),
    );
  }

  private async markFailedForRetry(id: string, attempts: number, lastError: string, now: Date): Promise<void> {
    const availableAt = new Date(now.getTime() + backoffMs(attempts));
    await withTenant(this.db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
      tx.update(schema.outbox).set({ status: "pending", attempts, lastError, availableAt }).where(eq(schema.outbox.id, id)),
    );
  }

  private async markDeadLetter(id: string, attempts: number, lastError: string): Promise<void> {
    await withTenant(this.db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
      tx.update(schema.outbox).set({ status: "dead_letter", attempts, lastError }).where(eq(schema.outbox.id, id)),
    );
  }
}
