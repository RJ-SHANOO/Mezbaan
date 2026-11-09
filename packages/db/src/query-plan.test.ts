import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import type { Pool } from "pg";
import { createDb, createPool, withTenant, type Database } from "./client.js";
import { branches, devices, outbox, restaurants, syncOperations } from "./schema/index.js";

/**
 * P1-33: EXPLAIN-based regression guard for a handful of genuinely critical,
 * high-frequency queries — not a general-purpose query-plan linter, just the
 * few places a missing index would actually hurt (section 9's p95 targets).
 * Small test tables get seq-scanned by Postgres's planner regardless of
 * indexes (a seq scan over a handful of rows is cheaper than an index lookup),
 * so each case here seeds enough rows first to make the planner's choice
 * actually meaningful.
 */
const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";
const SEED_ROW_COUNT = 5000;

let pool: Pool;
let db: Database;
// Each test here seeds SEED_ROW_COUNT rows under its own fresh restaurant — cheap to
// create, expensive to leave behind: a previous version of this file didn't clean up
// and silently accumulated tens of thousands of rows in the shared outbox/devices/
// sync_operations tables across repeated local runs, which went on to make unrelated
// tests elsewhere (nest-core's outbox-worker suite) time out. Tracked here and swept
// in afterAll so rerunning this file locally never leaves that mess again.
const createdRestaurantIds: string[] = [];

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
});

afterAll(async () => {
  if (createdRestaurantIds.length > 0) {
    await withTenant(db, { restaurantId: null, isSuperAdmin: true }, async (tx) => {
      await tx.delete(outbox).where(inArray(outbox.restaurantId, createdRestaurantIds));
      await tx.delete(syncOperations).where(inArray(syncOperations.restaurantId, createdRestaurantIds));
      await tx.delete(devices).where(inArray(devices.restaurantId, createdRestaurantIds));
      await tx.delete(branches).where(inArray(branches.restaurantId, createdRestaurantIds));
      await tx.delete(restaurants).where(inArray(restaurants.id, createdRestaurantIds));
    });
  }
  await pool.end();
}, 30_000);

interface TenantForExplain {
  restaurantId?: string;
  isSuperAdmin?: boolean;
}

/** Runs EXPLAIN inside the same tenant context the real caller actually uses —
 * RLS folds `current_setting('app.restaurant_id')`/`app.is_super_admin` into the
 * query as an extra OR'd condition, and the planner's selectivity guess for that
 * unresolved condition can tip an otherwise-index-favorable plan into a seq scan
 * if the context is never set at all (which no real caller ever does — every
 * query in this codebase runs inside withTenant). */
async function usesIndexScan(sqlText: string, params: unknown[], tenant: TenantForExplain): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL app.restaurant_id = '${tenant.restaurantId ?? ""}'`);
    await client.query(`SET LOCAL app.is_super_admin = '${tenant.isSuperAdmin ? "true" : "false"}'`);
    const result = await client.query(`EXPLAIN (FORMAT JSON) ${sqlText}`, params);
    const plan = JSON.stringify(result.rows[0]?.["QUERY PLAN"]);
    return /Index.*Scan/.test(plan);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

describe("critical query plans use an index, not a full table scan (P1-33)", () => {
  it("validateDeviceToken's lookup (devices.token_hash + status) — the check on every device-authenticated request", async () => {
    const restaurantId = await withTenant(db, { restaurantId: null, isSuperAdmin: true }, async (tx) => {
      const restaurantRows = await tx
        .insert(restaurants)
        .values({ name: "qp-devices", slug: `qp-devices-${randomUUID()}`, commissionRateBasisPoints: 500 })
        .returning({ id: restaurants.id });
      const restaurant = restaurantRows[0];
      if (!restaurant) throw new Error("fixture: restaurant insert returned no row");

      const branchRows = await tx
        .insert(branches)
        .values({ restaurantId: restaurant.id, name: "Main", timezone: "Asia/Karachi" })
        .returning({ id: branches.id });
      const branch = branchRows[0];
      if (!branch) throw new Error("fixture: branch insert returned no row");

      await tx.insert(devices).values(
        Array.from({ length: SEED_ROW_COUNT }, (_, i) => ({
          restaurantId: restaurant.id,
          branchId: branch.id,
          label: `device-${i}`,
          deviceType: "pos_terminal" as const,
          tokenHash: randomUUID(),
          status: "active" as const,
        })),
      );
      return restaurant.id;
    });
    createdRestaurantIds.push(restaurantId);

    expect(
      // validateDeviceToken already knows the restaurantId (decoded from the token
      // itself) by the time it queries — same context here.
      await usesIndexScan(`SELECT * FROM devices WHERE token_hash = $1 AND status = 'active'`, [randomUUID()], {
        restaurantId,
      }),
    ).toBe(true);
    // Sanity: the fixture actually landed under this restaurant, so the seed path itself is real.
    expect(restaurantId).toBeTruthy();
  }, 30_000);

  it("the outbox worker's claim query (status + available_at) — polled continuously by apps/worker (P1-30)", async () => {
    const restaurantId = await withTenant(db, { restaurantId: null, isSuperAdmin: true }, async (tx) => {
      const restaurantRows = await tx
        .insert(restaurants)
        .values({ name: "qp-outbox", slug: `qp-outbox-${randomUUID()}`, commissionRateBasisPoints: 500 })
        .returning({ id: restaurants.id });
      const restaurant = restaurantRows[0];
      if (!restaurant) throw new Error("fixture: restaurant insert returned no row");

      // Realistic shape matters here: the claim query's WHERE status = 'pending' is
      // only selective (and so only worth an index for) when most rows AREN'T
      // pending — exactly like production, where the worker processes its backlog
      // continuously and only a small fraction is ever waiting at once. Seeding
      // every row as 'pending' (as OutboxService.record naturally would) makes the
      // predicate match 100% of the table, and the planner correctly prefers a seq
      // scan over an index for that — not a real regression, just an unrealistic seed.
      await tx.insert(outbox).values(
        Array.from({ length: SEED_ROW_COUNT }, (_, i) => ({
          restaurantId: restaurant.id,
          aggregateType: "widget",
          aggregateId: `w-${i}`,
          eventType: "widget.created",
          payload: {},
          status: i % 100 === 0 ? ("pending" as const) : ("processed" as const),
        })),
      );
      return restaurant.id;
    });
    createdRestaurantIds.push(restaurantId);

    expect(
      // OutboxWorkerService.claimBatch runs as super-admin (it scans every tenant).
      await usesIndexScan(
        `SELECT * FROM outbox WHERE status = 'pending' AND available_at <= now() ORDER BY created_at LIMIT 20`,
        [],
        { isSuperAdmin: true },
      ),
    ).toBe(true);
    expect(restaurantId).toBeTruthy();
  }, 30_000);

  it("the sync upstream endpoint's per-restaurant idempotency lookup (sync_operations)", async () => {
    const { restaurantId, branchId, deviceId } = await withTenant(db, { restaurantId: null, isSuperAdmin: true }, async (tx) => {
      const restaurantRows = await tx
        .insert(restaurants)
        .values({ name: "qp-sync", slug: `qp-sync-${randomUUID()}`, commissionRateBasisPoints: 500 })
        .returning({ id: restaurants.id });
      const restaurant = restaurantRows[0];
      if (!restaurant) throw new Error("fixture: restaurant insert returned no row");

      const branchRows = await tx
        .insert(branches)
        .values({ restaurantId: restaurant.id, name: "Main", timezone: "Asia/Karachi" })
        .returning({ id: branches.id });
      const branch = branchRows[0];
      if (!branch) throw new Error("fixture: branch insert returned no row");

      const deviceRows = await tx
        .insert(devices)
        .values({ restaurantId: restaurant.id, branchId: branch.id, label: "Terminal", deviceType: "pos_terminal" })
        .returning({ id: devices.id });
      const device = deviceRows[0];
      if (!device) throw new Error("fixture: device insert returned no row");

      await tx.insert(syncOperations).values(
        Array.from({ length: SEED_ROW_COUNT }, (_, i) => ({
          id: randomUUID(),
          restaurantId: restaurant.id,
          branchId: branch.id,
          deviceId: device.id,
          idempotencyKey: `op-${i}`,
          operationType: "widget.created",
          payload: "{}",
        })),
      );
      return { restaurantId: restaurant.id, branchId: branch.id, deviceId: device.id };
    });
    createdRestaurantIds.push(restaurantId);

    expect(
      // SyncService.receiveBatch runs under the submitting restaurant's own context.
      await usesIndexScan(
        `SELECT 1 FROM sync_operations WHERE restaurant_id = $1 AND idempotency_key = $2`,
        [restaurantId, "op-0"],
        { restaurantId },
      ),
    ).toBe(true);
    expect(branchId && deviceId).toBeTruthy();
  }, 30_000);
});
