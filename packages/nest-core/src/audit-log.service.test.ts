import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: AuditLogService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  service = new AuditLogService(db);
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

describe("AuditLogService.record()", () => {
  it("writes an entry visible only within its own tenant", async () => {
    const restaurantAId = await createRestaurant("audit-tenant-a");
    const restaurantBId = await createRestaurant("audit-tenant-b");

    await service.record({ restaurantId: restaurantAId, action: "test.recorded", targetType: "x", targetId: "1" });

    const seenByA = await withTenant(db, { restaurantId: restaurantAId }, (tx) => tx.select().from(schema.auditLogs));
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0]?.action).toBe("test.recorded");

    const seenByB = await withTenant(db, { restaurantId: restaurantBId }, (tx) => tx.select().from(schema.auditLogs));
    expect(seenByB).toEqual([]);
  });

  it("commits atomically with the caller's transaction when given a tx", async () => {
    const restaurantId = await createRestaurant("audit-atomic");

    await expect(
      withTenant(db, { restaurantId }, async (tx) => {
        await service.record({ restaurantId, action: "test.rolled-back" }, tx);
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    const seen = await withTenant(db, { restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(seen).toEqual([]);
  });
});
