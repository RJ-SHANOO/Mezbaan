import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { verifyBytes } from "./snapshot-signing.js";
import { SyncSnapshotService } from "./sync-snapshot.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: SyncSnapshotService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  service = new SyncSnapshotService(db);
});

afterAll(async () => {
  await pool.end();
});

async function ownerRoleId(): Promise<string> {
  const rows = await db.insert(schema.roles).values({ key: "owner", name: "Restaurant Owner" }).onConflictDoUpdate({ target: schema.roles.key, set: { name: "Restaurant Owner" } }).returning({ id: schema.roles.id });
  const id = rows[0]?.id;
  if (!id) throw new Error("fixture: role insert returned no row");
  return id;
}

async function createFixture(label: string): Promise<{ restaurantId: string; branchId: string; ownerUserId: string }> {
  const restaurantRows = await withTenant(db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
    tx.insert(schema.restaurants).values({ name: label, slug: `${label}-${randomUUID()}`, commissionRateBasisPoints: 500 }).returning({ id: schema.restaurants.id }),
  );
  const restaurantId = restaurantRows[0]?.id;
  if (!restaurantId) throw new Error("fixture: restaurant insert returned no row");

  return withTenant(db, { restaurantId }, async (tx) => {
    const branchRows = await tx.insert(schema.branches).values({ restaurantId, name: "Main", timezone: "Asia/Karachi" }).returning({ id: schema.branches.id });
    const branchId = branchRows[0]?.id;
    if (!branchId) throw new Error("fixture: branch insert returned no row");

    const ownerRows = await tx
      .insert(schema.users)
      .values({ restaurantId, branchId, roleId: await ownerRoleId(), email: `${label}@example.test`, passwordHash: "unused", displayName: label })
      .returning({ id: schema.users.id });
    const ownerUserId = ownerRows[0]?.id;
    if (!ownerUserId) throw new Error("fixture: user insert returned no row");

    return { restaurantId, branchId, ownerUserId };
  });
}

describe("SyncSnapshotService", () => {
  it("builds a snapshot whose signature verifies against its own content bytes", async () => {
    const fixture = await createFixture("snapshot-sign");

    const snapshot = await service.buildSnapshot(fixture.restaurantId);

    expect(verifyBytes(snapshot.contentJson, snapshot.signature)).toBe(true);
    expect(verifyBytes(snapshot.contentJson + "tampered", snapshot.signature)).toBe(false);
  });

  it("includes branches and staff, with a null pinHash for a user who hasn't set one", async () => {
    const fixture = await createFixture("snapshot-staff");

    const snapshot = await service.buildSnapshot(fixture.restaurantId);
    const content = JSON.parse(snapshot.contentJson) as { restaurantId: string; branches: Array<{ id: string }>; staff: Array<{ id: string; roleKey: string; pinHash: string | null }> };

    expect(content.restaurantId).toBe(fixture.restaurantId);
    expect(content.branches.map((b) => b.id)).toContain(fixture.branchId);
    const owner = content.staff.find((s) => s.id === fixture.ownerUserId);
    expect(owner).toMatchObject({ roleKey: "owner", pinHash: null });
  });

  it("includes a manager's PIN hash once one is set", async () => {
    const fixture = await createFixture("snapshot-pin");
    await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) =>
      tx.insert(schema.managerPins).values({ restaurantId: fixture.restaurantId, userId: fixture.ownerUserId, pinHash: "scrypt:fake-hash" }),
    );

    const snapshot = await service.buildSnapshot(fixture.restaurantId);
    const content = JSON.parse(snapshot.contentJson) as { staff: Array<{ id: string; pinHash: string | null }> };

    expect(content.staff.find((s) => s.id === fixture.ownerUserId)?.pinHash).toBe("scrypt:fake-hash");
  });

  it("never includes another restaurant's staff or branches", async () => {
    const a = await createFixture("snapshot-iso-a");
    const b = await createFixture("snapshot-iso-b");

    const snapshotA = await service.buildSnapshot(a.restaurantId);
    const content = JSON.parse(snapshotA.contentJson) as { staff: Array<{ id: string }>; branches: Array<{ id: string }> };

    expect(content.staff.map((s) => s.id)).not.toContain(b.ownerUserId);
    expect(content.branches.map((br) => br.id)).not.toContain(b.branchId);
  });
});
