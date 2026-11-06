import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { OnboardingService } from "./onboarding.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let onboardingService: OnboardingService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  onboardingService = new OnboardingService(db, new AuditLogService(db), {});
});

afterAll(async () => {
  await pool.end();
});

function signupParams(label: string) {
  return {
    restaurantName: `${label} Restaurant`,
    slug: `${label}-${randomUUID()}`,
    ownerEmail: `${label}@example.test`,
    ownerPassword: "a long enough password",
    ownerDisplayName: "The Owner",
    firstBranchName: "Main Branch",
    timezone: "Asia/Karachi",
  };
}

describe("OnboardingService.signup()", () => {
  it("creates a restaurant, first branch and Owner account, and audits it", async () => {
    const params = signupParams("signup-ok");
    const result = await onboardingService.signup(params);

    expect(result.restaurantId).toBeTruthy();
    expect(result.branchId).toBeTruthy();

    await withTenant(db, { restaurantId: result.restaurantId }, async (tx) => {
      const restaurantRows = await tx.select().from(schema.restaurants).where(eq(schema.restaurants.id, result.restaurantId));
      const restaurant = restaurantRows[0];
      expect(restaurant?.slug).toBe(params.slug);
      expect(restaurant?.commissionRateBasisPoints).toBe(500); // platform default

      const branchRows = await tx.select().from(schema.branches).where(eq(schema.branches.id, result.branchId));
      expect(branchRows[0]?.name).toBe(params.firstBranchName);

      const userRows = await tx
        .select({ email: schema.users.email, branchId: schema.users.branchId, roleKey: schema.roles.key })
        .from(schema.users)
        .innerJoin(schema.roles, eq(schema.users.roleId, schema.roles.id))
        .where(eq(schema.users.restaurantId, result.restaurantId));
      expect(userRows).toHaveLength(1);
      expect(userRows[0]?.email).toBe(params.ownerEmail);
      expect(userRows[0]?.roleKey).toBe("owner");
      expect(userRows[0]?.branchId).toBeNull(); // Owner: access to every branch

      const auditRows = await tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.restaurantId, result.restaurantId));
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]?.action).toBe("restaurant.signup");
    });
  });

  it("uses a configured default commission rate when one is provided", async () => {
    const service = new OnboardingService(db, new AuditLogService(db), { defaultCommissionRateBasisPoints: 750 });
    const result = await service.signup(signupParams("signup-custom-rate"));

    const rate = await withTenant(db, { restaurantId: result.restaurantId }, async (tx) => {
      const rows = await tx
        .select({ rate: schema.restaurants.commissionRateBasisPoints })
        .from(schema.restaurants)
        .where(eq(schema.restaurants.id, result.restaurantId));
      return rows[0]?.rate;
    });
    expect(rate).toBe(750);
  });

  it("rejects a slug that's already taken", async () => {
    const params = signupParams("signup-dup-slug");
    await onboardingService.signup(params);

    await expect(
      onboardingService.signup({ ...signupParams("signup-dup-slug-2"), slug: params.slug }),
    ).rejects.toThrow();
  });

  it("the commission rate can't be changed after signup, even bypassing the service", async () => {
    const result = await onboardingService.signup(signupParams("signup-locked-rate"));

    await expect(
      withTenant(db, { restaurantId: result.restaurantId }, (tx) =>
        tx.update(schema.restaurants).set({ commissionRateBasisPoints: 9999 }).where(eq(schema.restaurants.id, result.restaurantId)),
      ),
    ).rejects.toThrow();

    const rate = await withTenant(db, { restaurantId: result.restaurantId }, async (tx) => {
      const rows = await tx
        .select({ rate: schema.restaurants.commissionRateBasisPoints })
        .from(schema.restaurants)
        .where(eq(schema.restaurants.id, result.restaurantId));
      return rows[0]?.rate;
    });
    expect(rate).toBe(500); // unchanged
  });

  it("other restaurant columns can still be updated — only the commission rate is locked", async () => {
    const result = await onboardingService.signup(signupParams("signup-name-updatable"));

    await withTenant(db, { restaurantId: result.restaurantId }, (tx) =>
      tx.update(schema.restaurants).set({ name: "Renamed" }).where(eq(schema.restaurants.id, result.restaurantId)),
    );

    const name = await withTenant(db, { restaurantId: result.restaurantId }, async (tx) => {
      const rows = await tx.select({ name: schema.restaurants.name }).from(schema.restaurants).where(eq(schema.restaurants.id, result.restaurantId));
      return rows[0]?.name;
    });
    expect(name).toBe("Renamed");
  });
});
