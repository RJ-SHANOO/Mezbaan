import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { createDb, createPool, withTenant, type Database } from "./client.js";
import { auditLogs, branches, devices, managerPins, restaurants, roles, users } from "./schema/index.js";

/**
 * Connects as the restricted `mezbaan_app` role (see app-role.ts) — NOT the migration
 * owner — because Postgres table owners and superusers bypass RLS unconditionally.
 * Testing against the owner connection would prove nothing about whether RLS works.
 */
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
  // Creating a tenant is inherently a platform-level operation, not a tenant-scoped
  // one — there's no restaurant_id to act as until this returns. A real onboarding
  // flow (P1-15) runs this under a privileged/system context for the same reason.
  const rows = await withTenant(db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
    tx
      .insert(restaurants)
      .values({ name, slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID()}`, commissionRateBasisPoints: 500 })
      .returning({ id: restaurants.id }),
  );
  const row = rows[0];
  if (!row) throw new Error("createRestaurant: insert returned no row");
  return row.id;
}

describe("restaurants — tenant isolation", () => {
  it("a session sees only its own restaurant, never another tenant's", async () => {
    const restaurantAId = await createRestaurant("Tenant A");
    const restaurantBId = await createRestaurant("Tenant B");

    const seenByA = await withTenant(db, { restaurantId: restaurantAId }, (tx) => tx.select().from(restaurants));
    expect(seenByA.map((r) => r.id)).toEqual([restaurantAId]);

    const seenByB = await withTenant(db, { restaurantId: restaurantBId }, (tx) => tx.select().from(restaurants));
    expect(seenByB.map((r) => r.id)).toEqual([restaurantBId]);
  });

  it("fails closed — a session with no tenant context sees nothing", async () => {
    await createRestaurant("Tenant With No Context");
    const seen = await withTenant(db, { restaurantId: null }, (tx) => tx.select().from(restaurants));
    expect(seen).toEqual([]);
  });

  it("a super-admin session sees every tenant", async () => {
    const id1 = await createRestaurant("Tenant D");
    const id2 = await createRestaurant("Tenant E");
    const seen = await withTenant(db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
      tx.select().from(restaurants),
    );
    const seenIds = seen.map((r) => r.id);
    expect(seenIds).toContain(id1);
    expect(seenIds).toContain(id2);
  });

  it("only a super-admin session can delete a restaurant", async () => {
    const restaurantId = await createRestaurant("Tenant To Delete");
    const matchesThisRow = eq(restaurants.id, restaurantId);

    // Even though this session's tenant context matches the row, DELETE requires
    // super-admin — a plain tenant session can't delete its own restaurant row.
    await withTenant(db, { restaurantId }, (tx) => tx.delete(restaurants).where(matchesThisRow));
    const stillThere = await withTenant(db, { restaurantId }, (tx) => tx.select().from(restaurants));
    expect(stillThere).toHaveLength(1);

    await withTenant(db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
      tx.delete(restaurants).where(matchesThisRow),
    );
    const afterSuperAdminDelete = await withTenant(db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
      tx.select().from(restaurants).where(matchesThisRow),
    );
    expect(afterSuperAdminDelete).toEqual([]);
  });
});

describe("branches/devices — tenant isolation and cross-tenant write rejection", () => {
  it("a branch created under one tenant is invisible to another tenant's session", async () => {
    const restaurantAId = await createRestaurant("Tenant F");
    const restaurantBId = await createRestaurant("Tenant G");

    const branchAId = await withTenant(db, { restaurantId: restaurantAId }, async (tx) => {
      const rows = await tx
        .insert(branches)
        .values({ restaurantId: restaurantAId, name: "Main", timezone: "Asia/Karachi" })
        .returning({ id: branches.id });
      const row = rows[0];
      if (!row) throw new Error("insert returned no row");
      return row.id;
    });

    const seenByB = await withTenant(db, { restaurantId: restaurantBId }, (tx) => tx.select().from(branches));
    expect(seenByB).toEqual([]);

    const seenByA = await withTenant(db, { restaurantId: restaurantAId }, (tx) => tx.select().from(branches));
    expect(seenByA.map((b) => b.id)).toEqual([branchAId]);
  });

  it("rejects inserting a branch for a different restaurant than the session's own tenant", async () => {
    const restaurantAId = await createRestaurant("Tenant H");
    const restaurantBId = await createRestaurant("Tenant I");

    // Session is scoped to A but tries to claim the row belongs to B — the second
    // barrier (rule 2) must block this even if application code has a bug.
    await expect(
      withTenant(db, { restaurantId: restaurantAId }, (tx) =>
        tx.insert(branches).values({ restaurantId: restaurantBId, name: "Sneaky", timezone: "Asia/Karachi" }),
      ),
    ).rejects.toThrow();
  });

  it("devices are isolated per tenant the same way", async () => {
    const restaurantAId = await createRestaurant("Tenant J");
    const restaurantBId = await createRestaurant("Tenant K");

    await withTenant(db, { restaurantId: restaurantAId }, async (tx) => {
      const branchRows = await tx
        .insert(branches)
        .values({ restaurantId: restaurantAId, name: "Main", timezone: "Asia/Karachi" })
        .returning({ id: branches.id });
      const branch = branchRows[0];
      if (!branch) throw new Error("insert returned no row");
      await tx.insert(devices).values({
        restaurantId: restaurantAId,
        branchId: branch.id,
        label: "Front Counter POS",
        deviceType: "pos_terminal",
      });
    });

    const seenByB = await withTenant(db, { restaurantId: restaurantBId }, (tx) => tx.select().from(devices));
    expect(seenByB).toEqual([]);

    const seenByA = await withTenant(db, { restaurantId: restaurantAId }, (tx) => tx.select().from(devices));
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0]?.tokenHash).toBeNull(); // not paired yet
    expect(seenByA[0]?.status).toBe("active");
  });
});

describe("manager_pins/audit_logs — tenant isolation", () => {
  async function createUser(restaurantId: string, label: string): Promise<string> {
    const roleRows = await db
      .insert(roles)
      .values({ key: "cashier", name: "Cashier" })
      .onConflictDoUpdate({ target: roles.key, set: { name: "Cashier" } })
      .returning({ id: roles.id });
    const role = roleRows[0];
    if (!role) throw new Error("fixture: role insert returned no row");

    const userRows = await withTenant(db, { restaurantId }, (tx) =>
      tx
        .insert(users)
        .values({ restaurantId, roleId: role.id, email: `${label}@example.test`, passwordHash: "unused", displayName: label })
        .returning({ id: users.id }),
    );
    const user = userRows[0];
    if (!user) throw new Error("fixture: user insert returned no row");
    return user.id;
  }

  it("a manager_pins row is invisible to another tenant's session", async () => {
    const restaurantAId = await createRestaurant("Tenant Q");
    const restaurantBId = await createRestaurant("Tenant R");
    const userAId = await createUser(restaurantAId, "pin-tenant-a");

    await withTenant(db, { restaurantId: restaurantAId }, (tx) =>
      tx.insert(managerPins).values({ restaurantId: restaurantAId, userId: userAId, pinHash: "irrelevant" }),
    );

    const seenByB = await withTenant(db, { restaurantId: restaurantBId }, (tx) => tx.select().from(managerPins));
    expect(seenByB).toEqual([]);

    const seenByA = await withTenant(db, { restaurantId: restaurantAId }, (tx) => tx.select().from(managerPins));
    expect(seenByA).toHaveLength(1);
  });

  it("rejects inserting a manager_pins row for a different restaurant than the session's own tenant", async () => {
    const restaurantAId = await createRestaurant("Tenant S");
    const restaurantBId = await createRestaurant("Tenant T");
    const userBId = await createUser(restaurantBId, "pin-tenant-b");

    await expect(
      withTenant(db, { restaurantId: restaurantAId }, (tx) =>
        tx.insert(managerPins).values({ restaurantId: restaurantBId, userId: userBId, pinHash: "irrelevant" }),
      ),
    ).rejects.toThrow();
  });

  it("an audit_logs row is invisible to another tenant's session", async () => {
    const restaurantAId = await createRestaurant("Tenant U");
    const restaurantBId = await createRestaurant("Tenant V");

    await withTenant(db, { restaurantId: restaurantAId }, (tx) =>
      tx.insert(auditLogs).values({ restaurantId: restaurantAId, action: "test.isolation" }),
    );

    const seenByB = await withTenant(db, { restaurantId: restaurantBId }, (tx) => tx.select().from(auditLogs));
    expect(seenByB).toEqual([]);

    const seenByA = await withTenant(db, { restaurantId: restaurantAId }, (tx) => tx.select().from(auditLogs));
    expect(seenByA).toHaveLength(1);
  });
});
