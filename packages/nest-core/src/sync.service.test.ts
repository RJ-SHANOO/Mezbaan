import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { SyncService } from "./sync.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: SyncService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  service = new SyncService(db);
});

afterAll(async () => {
  await pool.end();
});

async function createFixture(label: string): Promise<{ restaurantId: string; branchId: string; deviceId: string }> {
  const restaurantRows = await withTenant(db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
    tx
      .insert(schema.restaurants)
      .values({ name: label, slug: `${label}-${randomUUID()}`, commissionRateBasisPoints: 500 })
      .returning({ id: schema.restaurants.id }),
  );
  const restaurant = restaurantRows[0];
  if (!restaurant) throw new Error("fixture: restaurant insert returned no row");

  return withTenant(db, { restaurantId: restaurant.id }, async (tx) => {
    const branchRows = await tx
      .insert(schema.branches)
      .values({ restaurantId: restaurant.id, name: "Main", timezone: "Asia/Karachi" })
      .returning({ id: schema.branches.id });
    const branch = branchRows[0];
    if (!branch) throw new Error("fixture: branch insert returned no row");

    const deviceRows = await tx
      .insert(schema.devices)
      .values({ restaurantId: restaurant.id, branchId: branch.id, label: `${label}-device`, deviceType: "pos_terminal" })
      .returning({ id: schema.devices.id });
    const device = deviceRows[0];
    if (!device) throw new Error("fixture: device insert returned no row");

    return { restaurantId: restaurant.id, branchId: branch.id, deviceId: device.id };
  });
}

function op(idempotencyKey: string) {
  return { id: randomUUID(), idempotencyKey, operationType: "widget.created", payload: '{"label":"a widget"}', createdAt: new Date().toISOString() };
}

describe("SyncService", () => {
  it("accepts a batch and persists each operation", async () => {
    const fixture = await createFixture("sync-accept");
    const operations = [op("op-1"), op("op-2")];

    const results = await service.receiveBatch({ ...fixture, operations });

    expect(results).toEqual([
      { id: operations[0]!.id, status: "accepted" },
      { id: operations[1]!.id, status: "accepted" },
    ]);
    const stored = await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) => tx.select().from(schema.syncOperations));
    expect(stored.map((s) => s.idempotencyKey).sort()).toEqual(["op-1", "op-2"]);
  });

  it("retrying the same idempotency key accepts again without creating a duplicate row", async () => {
    const fixture = await createFixture("sync-retry");
    const operation = op("op-dup");

    await service.receiveBatch({ ...fixture, operations: [operation] });
    const retryResult = await service.receiveBatch({ ...fixture, operations: [{ ...operation, id: randomUUID() }] });

    expect(retryResult).toEqual([{ id: retryResult[0]!.id, status: "accepted" }]);
    const stored = await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) => tx.select().from(schema.syncOperations));
    expect(stored.filter((s) => s.idempotencyKey === "op-dup")).toHaveLength(1);
  });

  it("retrying with the exact same id and idempotency key (the realistic crash-resume case) also just accepts again", async () => {
    const fixture = await createFixture("sync-exact-retry");
    const operation = op("op-exact");

    await service.receiveBatch({ ...fixture, operations: [operation] });
    const retryResult = await service.receiveBatch({ ...fixture, operations: [operation] });

    expect(retryResult).toEqual([{ id: operation.id, status: "accepted" }]);
    const stored = await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) => tx.select().from(schema.syncOperations));
    expect(stored.filter((s) => s.idempotencyKey === "op-exact")).toHaveLength(1);
  });

  it("P1-31: two concurrent submissions of the same idempotency key race safely and never produce a duplicate row", async () => {
    const fixture = await createFixture("sync-concurrent-dup");
    const operation = op("op-race");

    // Both resolve concurrently rather than one awaited after the other — this is
    // what actually exercises the unique-constraint race (two terminals' retries
    // overlapping on the network), not just sequential idempotency.
    const results = await Promise.all([
      service.receiveBatch({ ...fixture, operations: [{ ...operation, id: randomUUID() }] }),
      service.receiveBatch({ ...fixture, operations: [{ ...operation, id: randomUUID() }] }),
    ]);

    expect(results[0]).toEqual([{ id: results[0]![0]!.id, status: "accepted" }]);
    expect(results[1]).toEqual([{ id: results[1]![0]!.id, status: "accepted" }]);
    const stored = await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) => tx.select().from(schema.syncOperations));
    expect(stored.filter((s) => s.idempotencyKey === "op-race")).toHaveLength(1);
  });

  it("an operation recorded under one restaurant is never visible to another's reads", async () => {
    const a = await createFixture("sync-iso-a");
    const b = await createFixture("sync-iso-b");
    await service.receiveBatch({ ...a, operations: [op("op-a")] });

    const seenByB = await withTenant(db, { restaurantId: b.restaurantId }, (tx) => tx.select().from(schema.syncOperations));
    expect(seenByB).toEqual([]);
  });
});
