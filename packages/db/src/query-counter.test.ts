import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { Pool } from "pg";
import { createPool, withTenant } from "./client.js";
import { createCountingDb } from "./query-counter.js";
import { branches, restaurants } from "./schema/index.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
});

afterAll(async () => {
  await pool.end();
});

describe("createCountingDb (N+1 detection, P1-33)", () => {
  it("one query per row (the N+1 smell) vs one batched query (the fix) — on the same data", async () => {
    const { db, count } = createCountingDb(pool);

    const restaurantIds = await withTenant(db, { restaurantId: null, isSuperAdmin: true }, async (tx) => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const rows = await tx
          .insert(restaurants)
          .values({ name: `qc-${i}`, slug: `qc-${i}-${randomUUID()}`, commissionRateBasisPoints: 500 })
          .returning({ id: restaurants.id });
        const row = rows[0];
        if (!row) throw new Error("fixture: restaurant insert returned no row");
        ids.push(row.id);
        await tx.insert(branches).values({ restaurantId: row.id, name: "Main", timezone: "Asia/Karachi" });
      }
      return ids;
    });

    // withTenant wraps every call in its own transaction (BEGIN + 2x SET LOCAL +
    // the query + COMMIT), so "one call" never costs literally 1 statement — the
    // invariant that actually distinguishes N+1 from a fix isn't the raw count,
    // it's how that per-call cost scales with the number of rows: constant for a
    // single batched call, linear in N for a separate call per row.
    const beforeSingleCall = count();
    await withTenant(db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
      tx.select().from(branches).where(inArray(branches.restaurantId, [restaurantIds[0]!])),
    );
    const perCallCost = count() - beforeSingleCall;

    // The N+1 pattern: fetch each restaurant's branches with a separate query per
    // row. This is what a naive "list then loop" implementation looks like.
    const beforeNPlus1 = count();
    for (const restaurantId of restaurantIds) {
      await withTenant(db, { restaurantId }, (tx) => tx.select().from(branches).where(eq(branches.restaurantId, restaurantId)));
    }
    const nPlus1QueryCount = count() - beforeNPlus1;
    expect(nPlus1QueryCount).toBe(restaurantIds.length * perCallCost); // scales linearly with row count — the bug this tool exists to catch

    // The fix: one batched call regardless of how many restaurants there are —
    // same per-call cost as fetching a single restaurant's branches above, not
    // multiplied by row count.
    const beforeBatched = count();
    await withTenant(db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
      tx.select().from(branches).where(inArray(branches.restaurantId, restaurantIds)),
    );
    const batchedQueryCount = count() - beforeBatched;
    expect(batchedQueryCount).toBe(perCallCost); // constant, regardless of row count
  });
});
