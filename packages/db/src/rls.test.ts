import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { createDb, createPool, withTenant, type Database } from "./client.js";
import {
  auditLogs,
  branches,
  categories,
  comboSlotItems,
  comboSlots,
  combos,
  devices,
  featureFlags,
  managerPins,
  modifierGroups,
  modifierOptions,
  outbox,
  passwordResetTokens,
  priceListItems,
  priceLists,
  productBranchAvailability,
  productModifierGroups,
  products,
  productVariants,
  restaurants,
  roles,
  sessions,
  syncOperations,
  users,
} from "./schema/index.js";

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

describe("manager_pins/audit_logs — tenant isolation", () => {
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

describe("sessions/password_reset_tokens — tenant isolation (P1-16)", () => {
  it("a sessions row is invisible to another tenant's session", async () => {
    const restaurantAId = await createRestaurant("Tenant W");
    const restaurantBId = await createRestaurant("Tenant X");
    const userAId = await createUser(restaurantAId, "session-tenant-a");

    await withTenant(db, { restaurantId: restaurantAId }, (tx) =>
      tx.insert(sessions).values({
        restaurantId: restaurantAId,
        userId: userAId,
        refreshTokenHash: "irrelevant",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );

    const seenByB = await withTenant(db, { restaurantId: restaurantBId }, (tx) => tx.select().from(sessions));
    expect(seenByB).toEqual([]);

    const seenByA = await withTenant(db, { restaurantId: restaurantAId }, (tx) => tx.select().from(sessions));
    expect(seenByA).toHaveLength(1);
  });

  it("rejects inserting a sessions row for a different restaurant than the session's own tenant", async () => {
    const restaurantAId = await createRestaurant("Tenant Y");
    const restaurantBId = await createRestaurant("Tenant Z");
    const userBId = await createUser(restaurantBId, "session-tenant-b");

    await expect(
      withTenant(db, { restaurantId: restaurantAId }, (tx) =>
        tx.insert(sessions).values({
          restaurantId: restaurantBId,
          userId: userBId,
          refreshTokenHash: "irrelevant",
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ),
    ).rejects.toThrow();
  });

  it("a password_reset_tokens row is invisible to another tenant's session", async () => {
    const restaurantAId = await createRestaurant("Tenant AA");
    const restaurantBId = await createRestaurant("Tenant BB");
    const userAId = await createUser(restaurantAId, "reset-tenant-a");

    await withTenant(db, { restaurantId: restaurantAId }, (tx) =>
      tx.insert(passwordResetTokens).values({
        restaurantId: restaurantAId,
        userId: userAId,
        tokenHash: "irrelevant",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );

    const seenByB = await withTenant(db, { restaurantId: restaurantBId }, (tx) => tx.select().from(passwordResetTokens));
    expect(seenByB).toEqual([]);

    const seenByA = await withTenant(db, { restaurantId: restaurantAId }, (tx) => tx.select().from(passwordResetTokens));
    expect(seenByA).toHaveLength(1);
  });

  it("rejects inserting a password_reset_tokens row for a different restaurant than the session's own tenant", async () => {
    const restaurantAId = await createRestaurant("Tenant CC");
    const restaurantBId = await createRestaurant("Tenant DD");
    const userBId = await createUser(restaurantBId, "reset-tenant-b");

    await expect(
      withTenant(db, { restaurantId: restaurantAId }, (tx) =>
        tx.insert(passwordResetTokens).values({
          restaurantId: restaurantBId,
          userId: userBId,
          tokenHash: "irrelevant",
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("feature_flags — writes are super-admin-only, reads are tenant-scoped (P1-23)", () => {
  it("a tenant session sees only its own restaurant's flags", async () => {
    const restaurantAId = await createRestaurant("Tenant EE");
    const restaurantBId = await createRestaurant("Tenant FF");

    await withTenant(db, { restaurantId: restaurantAId, isSuperAdmin: true }, (tx) =>
      tx.insert(featureFlags).values({ restaurantId: restaurantAId, moduleKey: "inventory", enabled: false }),
    );

    const seenByB = await withTenant(db, { restaurantId: restaurantBId }, (tx) => tx.select().from(featureFlags));
    expect(seenByB).toEqual([]);

    const seenByA = await withTenant(db, { restaurantId: restaurantAId }, (tx) => tx.select().from(featureFlags));
    expect(seenByA).toHaveLength(1);
  });

  it("a plain tenant session cannot insert a flag for its own restaurant — writes need a super-admin session", async () => {
    const restaurantId = await createRestaurant("Tenant GG");

    await expect(
      withTenant(db, { restaurantId }, (tx) => tx.insert(featureFlags).values({ restaurantId, moduleKey: "inventory", enabled: false })),
    ).rejects.toThrow();
  });

  it("a plain tenant session cannot update a flag for its own restaurant", async () => {
    const restaurantId = await createRestaurant("Tenant HH");
    const rows = await withTenant(db, { restaurantId, isSuperAdmin: true }, (tx) =>
      tx.insert(featureFlags).values({ restaurantId, moduleKey: "inventory", enabled: true }).returning({ id: featureFlags.id }),
    );
    const flagId = rows[0]?.id;
    if (!flagId) throw new Error("fixture: feature_flags insert returned no row");

    // Not a thrown error — RLS's `using` clause just makes the row invisible to the
    // UPDATE, so zero rows are affected (same as restaurants' delete-requires-super-admin case).
    await withTenant(db, { restaurantId }, (tx) => tx.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.id, flagId)));
    const stillEnabled = await withTenant(db, { restaurantId, isSuperAdmin: true }, (tx) =>
      tx.select().from(featureFlags).where(eq(featureFlags.id, flagId)),
    );
    expect(stillEnabled[0]?.enabled).toBe(true);
  });

  it("a super-admin session can insert, update, and read any restaurant's flags", async () => {
    const restaurantId = await createRestaurant("Tenant II");
    const rows = await withTenant(db, { restaurantId, isSuperAdmin: true }, (tx) =>
      tx.insert(featureFlags).values({ restaurantId, moduleKey: "kitchen", enabled: true }).returning({ id: featureFlags.id }),
    );
    const flagId = rows[0]?.id;
    if (!flagId) throw new Error("fixture: feature_flags insert returned no row");

    await withTenant(db, { restaurantId, isSuperAdmin: true }, (tx) =>
      tx.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.id, flagId)),
    );
    const seen = await withTenant(db, { restaurantId, isSuperAdmin: true }, (tx) => tx.select().from(featureFlags).where(eq(featureFlags.id, flagId)));
    expect(seen[0]?.enabled).toBe(false);
  });
});

describe("sync_operations — tenant isolation (P1-26)", () => {
  async function createFixture(name: string): Promise<{ restaurantId: string; branchId: string; deviceId: string }> {
    const restaurantId = await createRestaurant(name);
    return withTenant(db, { restaurantId }, async (tx) => {
      const branchRows = await tx
        .insert(branches)
        .values({ restaurantId, name: "Main", timezone: "Asia/Karachi" })
        .returning({ id: branches.id });
      const branchId = branchRows[0]?.id;
      if (!branchId) throw new Error("fixture: branch insert returned no row");

      const deviceRows = await tx
        .insert(devices)
        .values({ restaurantId, branchId, label: "Terminal", deviceType: "pos_terminal" })
        .returning({ id: devices.id });
      const deviceId = deviceRows[0]?.id;
      if (!deviceId) throw new Error("fixture: device insert returned no row");

      return { restaurantId, branchId, deviceId };
    });
  }

  it("a sync_operations row is invisible to another tenant's session", async () => {
    const a = await createFixture("Tenant JJ");
    const b = await createFixture("Tenant KK");

    await withTenant(db, { restaurantId: a.restaurantId }, (tx) =>
      tx.insert(syncOperations).values({
        id: randomUUID(),
        restaurantId: a.restaurantId,
        branchId: a.branchId,
        deviceId: a.deviceId,
        idempotencyKey: "op-a",
        operationType: "widget.created",
        payload: "{}",
      }),
    );

    const seenByB = await withTenant(db, { restaurantId: b.restaurantId }, (tx) => tx.select().from(syncOperations));
    expect(seenByB).toEqual([]);
  });

  it("rejects inserting a sync_operations row for a different restaurant than the session's own tenant", async () => {
    const a = await createFixture("Tenant LL");
    const b = await createFixture("Tenant MM");

    await expect(
      withTenant(db, { restaurantId: a.restaurantId }, (tx) =>
        tx.insert(syncOperations).values({
          id: randomUUID(),
          restaurantId: b.restaurantId,
          branchId: b.branchId,
          deviceId: b.deviceId,
          idempotencyKey: "op-cross",
          operationType: "widget.created",
          payload: "{}",
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("outbox — tenant isolation (P1-30)", () => {
  it("an outbox row is invisible to another tenant's session", async () => {
    const restaurantAId = await createRestaurant("Tenant NN");
    const restaurantBId = await createRestaurant("Tenant OO");

    await withTenant(db, { restaurantId: restaurantAId }, (tx) =>
      tx.insert(outbox).values({
        restaurantId: restaurantAId,
        aggregateType: "widget",
        aggregateId: "w1",
        eventType: "widget.created",
        payload: {},
      }),
    );

    const seenByB = await withTenant(db, { restaurantId: restaurantBId }, (tx) => tx.select().from(outbox));
    expect(seenByB).toEqual([]);
  });

  it("rejects inserting an outbox row for a different restaurant than the session's own tenant", async () => {
    const restaurantAId = await createRestaurant("Tenant PP");
    const restaurantBId = await createRestaurant("Tenant QQ");

    await expect(
      withTenant(db, { restaurantId: restaurantAId }, (tx) =>
        tx.insert(outbox).values({
          restaurantId: restaurantBId,
          aggregateType: "widget",
          aggregateId: "w2",
          eventType: "widget.created",
          payload: {},
        }),
      ),
    ).rejects.toThrow();
  });

  it("a super-admin session (the outbox worker's own context) sees every tenant's rows", async () => {
    const restaurantAId = await createRestaurant("Tenant RR");
    const restaurantBId = await createRestaurant("Tenant SS");
    // Unique per run — a hardcoded literal here would accumulate extra matching
    // rows every time this suite reruns against the same persistent local dev
    // database (CI always starts from a fresh one, so this only ever bit local
    // iteration, but it's still the wrong thing to rely on).
    const aggregateId = randomUUID();

    await withTenant(db, { restaurantId: restaurantAId }, (tx) =>
      tx.insert(outbox).values({ restaurantId: restaurantAId, aggregateType: "widget", aggregateId, eventType: "widget.created", payload: {} }),
    );
    await withTenant(db, { restaurantId: restaurantBId }, (tx) =>
      tx.insert(outbox).values({ restaurantId: restaurantBId, aggregateType: "widget", aggregateId: randomUUID(), eventType: "widget.created", payload: {} }),
    );

    const seenBySuperAdmin = await withTenant(db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
      tx.select().from(outbox).where(eq(outbox.aggregateId, aggregateId)),
    );
    expect(seenBySuperAdmin).toHaveLength(1);
  });
});

describe("categories/products/product_branch_availability — tenant isolation (P2-01)", () => {
  it("a category created under one tenant is never visible to another tenant's session", async () => {
    const restaurantAId = await createRestaurant("Tenant TT");
    const restaurantBId = await createRestaurant("Tenant UU");

    await withTenant(db, { restaurantId: restaurantAId }, (tx) => tx.insert(categories).values({ restaurantId: restaurantAId, name: "Burgers" }));

    const seenByB = await withTenant(db, { restaurantId: restaurantBId }, (tx) => tx.select().from(categories));
    expect(seenByB).toEqual([]);
  });

  it("rejects inserting a category for a different restaurant than the session's own tenant", async () => {
    const restaurantAId = await createRestaurant("Tenant VV");
    const restaurantBId = await createRestaurant("Tenant WW");

    await expect(
      withTenant(db, { restaurantId: restaurantAId }, (tx) => tx.insert(categories).values({ restaurantId: restaurantBId, name: "Hijacked" })),
    ).rejects.toThrow();
  });

  it("a product created under one tenant is never visible to another tenant's session", async () => {
    const restaurantAId = await createRestaurant("Tenant XX");
    const restaurantBId = await createRestaurant("Tenant YY");

    const categoryId = await withTenant(db, { restaurantId: restaurantAId }, async (tx) => {
      const rows = await tx.insert(categories).values({ restaurantId: restaurantAId, name: "Burgers" }).returning({ id: categories.id });
      const id = rows[0]?.id;
      if (!id) throw new Error("fixture: category insert returned no row");
      return id;
    });
    await withTenant(db, { restaurantId: restaurantAId }, (tx) =>
      tx.insert(products).values({ restaurantId: restaurantAId, categoryId, name: "Cheeseburger" }),
    );

    const seenByB = await withTenant(db, { restaurantId: restaurantBId }, (tx) => tx.select().from(products));
    expect(seenByB).toEqual([]);
  });

  it("rejects inserting a product for a different restaurant than the session's own tenant", async () => {
    const restaurantAId = await createRestaurant("Tenant ZZ");
    const restaurantBId = await createRestaurant("Tenant AAA");

    const categoryIdB = await withTenant(db, { restaurantId: restaurantBId }, async (tx) => {
      const rows = await tx.insert(categories).values({ restaurantId: restaurantBId, name: "Burgers" }).returning({ id: categories.id });
      const id = rows[0]?.id;
      if (!id) throw new Error("fixture: category insert returned no row");
      return id;
    });

    await expect(
      withTenant(db, { restaurantId: restaurantAId }, (tx) =>
        tx.insert(products).values({ restaurantId: restaurantBId, categoryId: categoryIdB, name: "Hijacked" }),
      ),
    ).rejects.toThrow();
  });

  it("a product_branch_availability row created under one tenant is never visible to another tenant's session", async () => {
    const restaurantAId = await createRestaurant("Tenant BBB");
    const restaurantBId = await createRestaurant("Tenant CCC");

    const { categoryId, branchId } = await withTenant(db, { restaurantId: restaurantAId }, async (tx) => {
      const categoryRows = await tx.insert(categories).values({ restaurantId: restaurantAId, name: "Burgers" }).returning({ id: categories.id });
      const categoryId = categoryRows[0]?.id;
      if (!categoryId) throw new Error("fixture: category insert returned no row");
      const branchRows = await tx.insert(branches).values({ restaurantId: restaurantAId, name: "Main", timezone: "Asia/Karachi" }).returning({ id: branches.id });
      const branchId = branchRows[0]?.id;
      if (!branchId) throw new Error("fixture: branch insert returned no row");
      return { categoryId, branchId };
    });
    const productId = await withTenant(db, { restaurantId: restaurantAId }, async (tx) => {
      const rows = await tx.insert(products).values({ restaurantId: restaurantAId, categoryId, name: "Cheeseburger" }).returning({ id: products.id });
      const id = rows[0]?.id;
      if (!id) throw new Error("fixture: product insert returned no row");
      return id;
    });
    await withTenant(db, { restaurantId: restaurantAId }, (tx) =>
      tx.insert(productBranchAvailability).values({ restaurantId: restaurantAId, productId, branchId, available: false }),
    );

    const seenByB = await withTenant(db, { restaurantId: restaurantBId }, (tx) => tx.select().from(productBranchAvailability));
    expect(seenByB).toEqual([]);
  });
});

describe("product_variants/modifier_groups/modifier_options/product_modifier_groups — tenant isolation (P2-02)", () => {
  it("a product variant created under one tenant is never visible to another tenant's session", async () => {
    const restaurantAId = await createRestaurant("Tenant DDD");
    const restaurantBId = await createRestaurant("Tenant EEE");

    const productId = await withTenant(db, { restaurantId: restaurantAId }, async (tx) => {
      const categoryRows = await tx.insert(categories).values({ restaurantId: restaurantAId, name: "Pizzas" }).returning({ id: categories.id });
      const categoryId = categoryRows[0]?.id;
      if (!categoryId) throw new Error("fixture: category insert returned no row");
      const productRows = await tx.insert(products).values({ restaurantId: restaurantAId, categoryId, name: "Margherita" }).returning({ id: products.id });
      const id = productRows[0]?.id;
      if (!id) throw new Error("fixture: product insert returned no row");
      return id;
    });
    await withTenant(db, { restaurantId: restaurantAId }, (tx) => tx.insert(productVariants).values({ restaurantId: restaurantAId, productId, name: "Large" }));

    const seenByB = await withTenant(db, { restaurantId: restaurantBId }, (tx) => tx.select().from(productVariants));
    expect(seenByB).toEqual([]);
  });

  it("a modifier group created under one tenant is never visible to another tenant's session", async () => {
    const restaurantAId = await createRestaurant("Tenant FFF");
    const restaurantBId = await createRestaurant("Tenant GGG");

    await withTenant(db, { restaurantId: restaurantAId }, (tx) => tx.insert(modifierGroups).values({ restaurantId: restaurantAId, name: "Sauce" }));

    const seenByB = await withTenant(db, { restaurantId: restaurantBId }, (tx) => tx.select().from(modifierGroups));
    expect(seenByB).toEqual([]);
  });

  it("a modifier option created under one tenant is never visible to another tenant's session", async () => {
    const restaurantAId = await createRestaurant("Tenant HHH");
    const restaurantBId = await createRestaurant("Tenant III");

    const modifierGroupId = await withTenant(db, { restaurantId: restaurantAId }, async (tx) => {
      const rows = await tx.insert(modifierGroups).values({ restaurantId: restaurantAId, name: "Sauce" }).returning({ id: modifierGroups.id });
      const id = rows[0]?.id;
      if (!id) throw new Error("fixture: modifier group insert returned no row");
      return id;
    });
    await withTenant(db, { restaurantId: restaurantAId }, (tx) =>
      tx.insert(modifierOptions).values({ restaurantId: restaurantAId, modifierGroupId, name: "Ketchup" }),
    );

    const seenByB = await withTenant(db, { restaurantId: restaurantBId }, (tx) => tx.select().from(modifierOptions));
    expect(seenByB).toEqual([]);
  });

  it("a product_modifier_groups row created under one tenant is never visible to another tenant's session", async () => {
    const restaurantAId = await createRestaurant("Tenant JJJ");
    const restaurantBId = await createRestaurant("Tenant KKK");

    const { productId, modifierGroupId } = await withTenant(db, { restaurantId: restaurantAId }, async (tx) => {
      const categoryRows = await tx.insert(categories).values({ restaurantId: restaurantAId, name: "Pizzas" }).returning({ id: categories.id });
      const categoryId = categoryRows[0]?.id;
      if (!categoryId) throw new Error("fixture: category insert returned no row");
      const productRows = await tx.insert(products).values({ restaurantId: restaurantAId, categoryId, name: "Margherita" }).returning({ id: products.id });
      const productId = productRows[0]?.id;
      if (!productId) throw new Error("fixture: product insert returned no row");
      const groupRows = await tx.insert(modifierGroups).values({ restaurantId: restaurantAId, name: "Sauce" }).returning({ id: modifierGroups.id });
      const modifierGroupId = groupRows[0]?.id;
      if (!modifierGroupId) throw new Error("fixture: modifier group insert returned no row");
      return { productId, modifierGroupId };
    });
    await withTenant(db, { restaurantId: restaurantAId }, (tx) =>
      tx.insert(productModifierGroups).values({ restaurantId: restaurantAId, productId, modifierGroupId }),
    );

    const seenByB = await withTenant(db, { restaurantId: restaurantBId }, (tx) => tx.select().from(productModifierGroups));
    expect(seenByB).toEqual([]);
  });
});

describe("combos/combo_slots/combo_slot_items — tenant isolation (P2-03)", () => {
  it("a combo created under one tenant is never visible to another tenant's session", async () => {
    const restaurantAId = await createRestaurant("Tenant LLL");
    const restaurantBId = await createRestaurant("Tenant MMM");

    await withTenant(db, { restaurantId: restaurantAId }, (tx) => tx.insert(combos).values({ restaurantId: restaurantAId, name: "Deal" }));

    const seenByB = await withTenant(db, { restaurantId: restaurantBId }, (tx) => tx.select().from(combos));
    expect(seenByB).toEqual([]);
  });

  it("a combo slot created under one tenant is never visible to another tenant's session", async () => {
    const restaurantAId = await createRestaurant("Tenant NNN");
    const restaurantBId = await createRestaurant("Tenant OOO");

    const comboId = await withTenant(db, { restaurantId: restaurantAId }, async (tx) => {
      const rows = await tx.insert(combos).values({ restaurantId: restaurantAId, name: "Deal" }).returning({ id: combos.id });
      const id = rows[0]?.id;
      if (!id) throw new Error("fixture: combo insert returned no row");
      return id;
    });
    await withTenant(db, { restaurantId: restaurantAId }, (tx) =>
      tx.insert(comboSlots).values({ restaurantId: restaurantAId, comboId, name: "Side", kind: "fixed", minSelections: 1, maxSelections: 1 }),
    );

    const seenByB = await withTenant(db, { restaurantId: restaurantBId }, (tx) => tx.select().from(comboSlots));
    expect(seenByB).toEqual([]);
  });

  it("a combo_slot_items row created under one tenant is never visible to another tenant's session", async () => {
    const restaurantAId = await createRestaurant("Tenant PPP");
    const restaurantBId = await createRestaurant("Tenant QQQ");

    const { comboSlotId, productId } = await withTenant(db, { restaurantId: restaurantAId }, async (tx) => {
      const comboRows = await tx.insert(combos).values({ restaurantId: restaurantAId, name: "Deal" }).returning({ id: combos.id });
      const comboId = comboRows[0]?.id;
      if (!comboId) throw new Error("fixture: combo insert returned no row");
      const slotRows = await tx
        .insert(comboSlots)
        .values({ restaurantId: restaurantAId, comboId, name: "Side", kind: "fixed", minSelections: 1, maxSelections: 1 })
        .returning({ id: comboSlots.id });
      const comboSlotId = slotRows[0]?.id;
      if (!comboSlotId) throw new Error("fixture: combo slot insert returned no row");
      const categoryRows = await tx.insert(categories).values({ restaurantId: restaurantAId, name: "Sides" }).returning({ id: categories.id });
      const categoryId = categoryRows[0]?.id;
      if (!categoryId) throw new Error("fixture: category insert returned no row");
      const productRows = await tx.insert(products).values({ restaurantId: restaurantAId, categoryId, name: "Fries" }).returning({ id: products.id });
      const productId = productRows[0]?.id;
      if (!productId) throw new Error("fixture: product insert returned no row");
      return { comboSlotId, productId };
    });
    await withTenant(db, { restaurantId: restaurantAId }, (tx) =>
      tx.insert(comboSlotItems).values({ restaurantId: restaurantAId, comboSlotId, productId }),
    );

    const seenByB = await withTenant(db, { restaurantId: restaurantBId }, (tx) => tx.select().from(comboSlotItems));
    expect(seenByB).toEqual([]);
  });
});

describe("price_lists/price_list_items — tenant isolation (P2-04)", () => {
  it("a price list created under one tenant is never visible to another tenant's session", async () => {
    const restaurantAId = await createRestaurant("Tenant RRR");
    const restaurantBId = await createRestaurant("Tenant SSS2");

    await withTenant(db, { restaurantId: restaurantAId }, (tx) => tx.insert(priceLists).values({ restaurantId: restaurantAId, name: "Standard", currency: "PKR" }));

    const seenByB = await withTenant(db, { restaurantId: restaurantBId }, (tx) => tx.select().from(priceLists));
    expect(seenByB).toEqual([]);
  });

  it("a price_list_items row created under one tenant is never visible to another tenant's session", async () => {
    const restaurantAId = await createRestaurant("Tenant TTT2");
    const restaurantBId = await createRestaurant("Tenant UUU2");

    const { priceListId, productId } = await withTenant(db, { restaurantId: restaurantAId }, async (tx) => {
      const priceListRows = await tx.insert(priceLists).values({ restaurantId: restaurantAId, name: "Standard", currency: "PKR" }).returning({ id: priceLists.id });
      const priceListId = priceListRows[0]?.id;
      if (!priceListId) throw new Error("fixture: price list insert returned no row");
      const categoryRows = await tx.insert(categories).values({ restaurantId: restaurantAId, name: "Burgers" }).returning({ id: categories.id });
      const categoryId = categoryRows[0]?.id;
      if (!categoryId) throw new Error("fixture: category insert returned no row");
      const productRows = await tx.insert(products).values({ restaurantId: restaurantAId, categoryId, name: "Cheeseburger" }).returning({ id: products.id });
      const productId = productRows[0]?.id;
      if (!productId) throw new Error("fixture: product insert returned no row");
      return { priceListId, productId };
    });
    await withTenant(db, { restaurantId: restaurantAId }, (tx) =>
      tx.insert(priceListItems).values({ restaurantId: restaurantAId, priceListId, productId, unitPriceMinor: 1500n }),
    );

    const seenByB = await withTenant(db, { restaurantId: restaurantBId }, (tx) => tx.select().from(priceListItems));
    expect(seenByB).toEqual([]);
  });

  it("the restaurant+name+version UNIQUE index actually rejects a duplicate version (the real guarantee, not just the trigger's usual behavior)", async () => {
    const restaurantId = await createRestaurant("Tenant VVV2");

    const firstVersion = await withTenant(db, { restaurantId }, async (tx) => {
      const rows = await tx.insert(priceLists).values({ restaurantId, name: "Standard", currency: "PKR" }).returning({ version: priceLists.version });
      const version = rows[0]?.version;
      if (version === undefined) throw new Error("fixture: price list insert returned no row");
      return version;
    });

    await expect(
      withTenant(db, { restaurantId }, (tx) => tx.insert(priceLists).values({ restaurantId, name: "Standard", currency: "PKR", version: firstVersion })),
    ).rejects.toThrow();
  });
});
