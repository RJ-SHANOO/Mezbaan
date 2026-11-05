import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createDb, createPool, withTenant, type Database } from "./client.js";
import { restaurants, roles, users } from "./schema/index.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let cashierRoleId: string;

beforeAll(async () => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);

  // roles has no RLS and isn't scoped to a tenant, so this fixture doesn't need
  // withTenant — but make it idempotent in case another test run already seeded it.
  const rows = await db
    .insert(roles)
    .values({ key: "cashier", name: "Cashier" })
    .onConflictDoUpdate({ target: roles.key, set: { name: "Cashier" } })
    .returning({ id: roles.id });
  const row = rows[0];
  if (!row) throw new Error("fixture: cashier role insert returned no row");
  cashierRoleId = row.id;
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
      .values({
        name,
        slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID()}`,
        commissionRateBasisPoints: 500,
      })
      .returning({ id: restaurants.id }),
  );
  const row = rows[0];
  if (!row) throw new Error("createRestaurant: insert returned no row");
  return row.id;
}

describe("users", () => {
  it("creates a user scoped to a restaurant with no branch (e.g. an Owner)", async () => {
    const restaurantId = await createRestaurant("Tenant With Owner");

    await withTenant(db, { restaurantId }, (tx) =>
      tx.insert(users).values({
        restaurantId,
        branchId: null,
        roleId: cashierRoleId,
        email: "owner@example.test",
        passwordHash: "hashed",
        displayName: "The Owner",
      }),
    );

    const seen = await withTenant(db, { restaurantId }, (tx) => tx.select().from(users));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.branchId).toBeNull();
  });

  it("allows the same email in two different restaurants", async () => {
    const restaurantAId = await createRestaurant("Tenant L");
    const restaurantBId = await createRestaurant("Tenant M");
    const email = "shared@example.test";

    await withTenant(db, { restaurantId: restaurantAId }, (tx) =>
      tx.insert(users).values({
        restaurantId: restaurantAId,
        roleId: cashierRoleId,
        email,
        passwordHash: "hashed",
        displayName: "Cashier A",
      }),
    );

    // Should NOT throw — email uniqueness is scoped per restaurant, not global.
    await expect(
      withTenant(db, { restaurantId: restaurantBId }, (tx) =>
        tx.insert(users).values({
          restaurantId: restaurantBId,
          roleId: cashierRoleId,
          email,
          passwordHash: "hashed",
          displayName: "Cashier B",
        }),
      ),
    ).resolves.not.toThrow();
  });

  it("rejects a duplicate email within the same restaurant", async () => {
    const restaurantId = await createRestaurant("Tenant N");
    const email = "duplicate@example.test";

    await withTenant(db, { restaurantId }, (tx) =>
      tx.insert(users).values({
        restaurantId,
        roleId: cashierRoleId,
        email,
        passwordHash: "hashed",
        displayName: "First",
      }),
    );

    await expect(
      withTenant(db, { restaurantId }, (tx) =>
        tx.insert(users).values({
          restaurantId,
          roleId: cashierRoleId,
          email,
          passwordHash: "hashed",
          displayName: "Second",
        }),
      ),
    ).rejects.toThrow();
  });

  it("a user is invisible to a session scoped to a different restaurant", async () => {
    const restaurantAId = await createRestaurant("Tenant O");
    const restaurantBId = await createRestaurant("Tenant P");

    await withTenant(db, { restaurantId: restaurantAId }, (tx) =>
      tx.insert(users).values({
        restaurantId: restaurantAId,
        roleId: cashierRoleId,
        email: "only-a@example.test",
        passwordHash: "hashed",
        displayName: "Only A",
      }),
    );

    const seenByB = await withTenant(db, { restaurantId: restaurantBId }, (tx) => tx.select().from(users));
    expect(seenByB).toEqual([]);
  });
});
