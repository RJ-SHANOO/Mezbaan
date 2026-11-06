import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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

  it("is append-only at the database level — even a direct UPDATE/DELETE as the app role is rejected", async () => {
    const restaurantId = await createRestaurant("audit-append-only");
    await service.record({ restaurantId, action: "test.immutable" });

    // Bypasses the service entirely: proves the guarantee is app-role.ts's REVOKE
    // UPDATE, DELETE, not just "nobody happens to call update()/delete() today".
    await expect(
      withTenant(db, { restaurantId }, (tx) => tx.update(schema.auditLogs).set({ action: "tampered" }).where(eq(schema.auditLogs.restaurantId, restaurantId))),
    ).rejects.toThrow();
    await expect(
      withTenant(db, { restaurantId }, (tx) => tx.delete(schema.auditLogs).where(eq(schema.auditLogs.restaurantId, restaurantId))),
    ).rejects.toThrow();

    const seen = await withTenant(db, { restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.action).toBe("test.immutable");
  });
});
