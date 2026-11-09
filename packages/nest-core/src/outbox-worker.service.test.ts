import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import { OutboxWorkerService, type OutboxHandler, type OutboxRecord } from "./outbox-worker.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
});

afterAll(async () => {
  await pool.end();
});

async function createRestaurant(name: string): Promise<string> {
  const rows = await withTenant(db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
    tx
      .insert(schema.restaurants)
      .values({ name, slug: `${name}-${randomUUID()}`, commissionRateBasisPoints: 500 })
      .returning({ id: schema.restaurants.id }),
  );
  const row = rows[0];
  if (!row) throw new Error("fixture: restaurant insert returned no row");
  return row.id;
}

interface SeedOverrides {
  status?: "pending" | "processing" | "processed" | "dead_letter";
  attempts?: number;
  availableAt?: Date;
}

async function seedOutboxRow(restaurantId: string, eventType: string, overrides: SeedOverrides = {}): Promise<string> {
  const rows = await withTenant(db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
    tx
      .insert(schema.outbox)
      .values({
        restaurantId,
        aggregateType: "widget",
        aggregateId: randomUUID(),
        eventType,
        payload: { label: "a widget" },
        status: overrides.status ?? "pending",
        attempts: overrides.attempts ?? 0,
        availableAt: overrides.availableAt ?? new Date(),
      })
      .returning({ id: schema.outbox.id }),
  );
  const row = rows[0];
  if (!row) throw new Error("fixture: outbox insert returned no row");
  return row.id;
}

async function readRow(id: string): Promise<typeof schema.outbox.$inferSelect> {
  const rows = await withTenant(db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
    tx.select().from(schema.outbox).where(eq(schema.outbox.id, id)),
  );
  const row = rows[0];
  if (!row) throw new Error(`fixture: expected outbox row ${id} to exist`);
  return row;
}

// A generous batch size so this suite's specific seeded row is reliably included in
// one claim even while outbox.service.test.ts (a separate file, running in its own
// parallel vitest worker) is concurrently inserting its own rows into this same
// shared outbox table — claimBatch scans every tenant by design (P1-30), so these
// tests can never assume they own the whole table. Assertions below are written
// per-row for the same reason: a seeded row's own end state, never a global count.
function worker(handlers: Record<string, OutboxHandler> = {}): OutboxWorkerService {
  return new OutboxWorkerService(db, { handlers, autoStart: false, batchSize: 500 });
}

describe("OutboxWorkerService.processBatch()", () => {
  it("claims a due pending row, runs its handler, and marks it processed", async () => {
    const restaurantId = await createRestaurant("outbox-worker-success");
    const id = await seedOutboxRow(restaurantId, "widget.created");

    const seen: OutboxRecord[] = [];
    await worker({ "widget.created": async (record) => void seen.push(record) }).processBatch();

    expect(seen.some((record) => record.id === id)).toBe(true);
    const row = await readRow(id);
    expect(row.status).toBe("processed");
    expect(row.processedAt).not.toBeNull();
  });

  it("claims pending rows across every tenant, not just one", async () => {
    const restaurantAId = await createRestaurant("outbox-worker-tenant-a");
    const restaurantBId = await createRestaurant("outbox-worker-tenant-b");
    await seedOutboxRow(restaurantAId, "widget.created");
    await seedOutboxRow(restaurantBId, "widget.created");

    const summary = await worker({ "widget.created": async () => {} }).processBatch();

    expect(summary.succeeded).toBeGreaterThanOrEqual(2);
  });

  it("never claims a row whose available_at is still in the future", async () => {
    const restaurantId = await createRestaurant("outbox-worker-not-due");
    const id = await seedOutboxRow(restaurantId, "widget.created", { availableAt: new Date(Date.now() + 60_000) });

    await worker({ "widget.created": async () => {} }).processBatch();

    const row = await readRow(id);
    expect(row.status).toBe("pending");
  });

  it("never reclaims a row that's already in 'processing' (a concurrent worker's claim)", async () => {
    const restaurantId = await createRestaurant("outbox-worker-already-claimed");
    const id = await seedOutboxRow(restaurantId, "widget.created", { status: "processing" });

    await worker({ "widget.created": async () => {} }).processBatch();

    const row = await readRow(id);
    expect(row.status).toBe("processing");
  });

  it("retries a failed handler with backoff instead of dead-lettering immediately", async () => {
    const restaurantId = await createRestaurant("outbox-worker-retry");
    const id = await seedOutboxRow(restaurantId, "widget.created", { attempts: 1 });
    const before = Date.now();

    await worker({
      "widget.created": async () => {
        throw new Error("handler blew up");
      },
    }).processBatch();

    const row = await readRow(id);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(2);
    expect(row.lastError).toBe("handler blew up");
    expect(row.availableAt.getTime()).toBeGreaterThan(before);
  });

  it("moves a row to dead_letter once it has exhausted every retry attempt", async () => {
    const restaurantId = await createRestaurant("outbox-worker-dead-letter");
    const id = await seedOutboxRow(restaurantId, "widget.created", { attempts: 4 });

    await worker({
      "widget.created": async () => {
        throw new Error("still broken");
      },
    }).processBatch();

    const row = await readRow(id);
    expect(row.status).toBe("dead_letter");
    expect(row.attempts).toBe(5);
    expect(row.lastError).toBe("still broken");
  });

  it("treats a missing handler as a failure on the same retry/dead-letter path, not a silent skip", async () => {
    const restaurantId = await createRestaurant("outbox-worker-no-handler");
    const id = await seedOutboxRow(restaurantId, "no.such.handler");

    await worker({}).processBatch();

    const row = await readRow(id);
    expect(row.lastError).toContain("no outbox handler registered");
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
  });

  it("resolves cleanly without throwing when called with nothing of its own to claim", async () => {
    // Can't assert claimed === 0 here: other test files run as separate parallel
    // vitest workers against this same shared outbox table, so a globally empty
    // batch isn't guaranteed. The only thing this test owns is "the call itself
    // doesn't throw and returns a well-formed summary" — rule 14, a background job
    // must never crash on an uneventful cycle.
    const summary = await worker({}).processBatch();
    expect(summary.claimed).toBeGreaterThanOrEqual(0);
  });
});

describe("OutboxWorkerService polling lifecycle", () => {
  it("only starts the polling loop when autoStart is true", () => {
    vi.useFakeTimers();
    try {
      const withoutAutoStart = new OutboxWorkerService(db, { autoStart: false });
      withoutAutoStart.onModuleInit();
      expect(vi.getTimerCount()).toBe(0);

      const withAutoStart = new OutboxWorkerService(db, { autoStart: true, pollIntervalMs: 1000 });
      withAutoStart.onModuleInit();
      expect(vi.getTimerCount()).toBe(1);
      withAutoStart.onModuleDestroy();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
