import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { AuthService } from "./auth.service.js";
import { hashPassword } from "./password.js";
import { verifyAccessToken } from "./tenant-context.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";
const SECRET = "test-secret";

let pool: Pool;
let db: Database;
let authService: AuthService;
let cashierRoleId: string;

beforeAll(async () => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  authService = new AuthService(db, new AuditLogService(db), { jwtSecret: SECRET });

  const rows = await db
    .insert(schema.roles)
    .values({ key: "cashier", name: "Cashier" })
    .onConflictDoUpdate({ target: schema.roles.key, set: { name: "Cashier" } })
    .returning({ id: schema.roles.id });
  const row = rows[0];
  if (!row) throw new Error("fixture: cashier role insert returned no row");
  cashierRoleId = row.id;
});

afterAll(async () => {
  await pool.end();
});

interface Fixture {
  restaurantId: string;
  slug: string;
  email: string;
  password: string;
  userId: string;
}

async function createRestaurantWithUser(label: string): Promise<Fixture> {
  const slug = `${label}-${randomUUID()}`;
  const email = `${label}@example.test`;
  const password = "correct horse battery staple";

  const restaurantRows = await withTenant(db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
    tx
      .insert(schema.restaurants)
      .values({ name: label, slug, commissionRateBasisPoints: 500 })
      .returning({ id: schema.restaurants.id }),
  );
  const restaurant = restaurantRows[0];
  if (!restaurant) throw new Error("fixture: restaurant insert returned no row");

  const passwordHash = await hashPassword(password);
  const userRows = await withTenant(db, { restaurantId: restaurant.id }, (tx) =>
    tx
      .insert(schema.users)
      .values({ restaurantId: restaurant.id, roleId: cashierRoleId, email, passwordHash, displayName: label })
      .returning({ id: schema.users.id }),
  );
  const user = userRows[0];
  if (!user) throw new Error("fixture: user insert returned no row");

  return { restaurantId: restaurant.id, slug, email, password, userId: user.id };
}

async function auditActions(restaurantId: string): Promise<string[]> {
  const rows = await withTenant(db, { restaurantId }, (tx) =>
    tx.select({ action: schema.auditLogs.action }).from(schema.auditLogs).where(eq(schema.auditLogs.restaurantId, restaurantId)),
  );
  return rows.map((r) => r.action);
}

describe("login()", () => {
  it("succeeds with correct credentials and the access token carries the right claims", async () => {
    const fixture = await createRestaurantWithUser("login-ok");
    const result = await authService.login({ restaurantSlug: fixture.slug, email: fixture.email, password: fixture.password });
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();

    const claims = verifyAccessToken(result.accessToken, SECRET);
    expect(claims.sub).toBe(fixture.userId);
    expect(claims.restaurantId).toBe(fixture.restaurantId);
    expect(claims.roleKey).toBe("cashier");
    expect(claims.isSuperAdmin).toBe(false);
    // Routine login success isn't an audited event (P1-14 scope) — only the
    // security-state-changing actions below (logout, password reset) are.
    expect(await auditActions(fixture.restaurantId)).toEqual([]);
  });

  it("rejects the wrong password", async () => {
    const fixture = await createRestaurantWithUser("login-bad-pw");
    await expect(
      authService.login({ restaurantSlug: fixture.slug, email: fixture.email, password: "wrong" }),
    ).rejects.toThrow();
  });

  it("rejects an unknown email", async () => {
    const fixture = await createRestaurantWithUser("login-no-email");
    await expect(
      authService.login({ restaurantSlug: fixture.slug, email: "nobody@example.test", password: fixture.password }),
    ).rejects.toThrow();
  });

  it("rejects an unknown restaurant slug", async () => {
    await expect(
      authService.login({ restaurantSlug: `no-such-restaurant-${randomUUID()}`, email: "x@example.test", password: "x" }),
    ).rejects.toThrow();
  });

  it("a user in one restaurant can't log into a different restaurant, even with a same-email account there", async () => {
    const tenantA = await createRestaurantWithUser("cross-tenant-a");
    const tenantB = await createRestaurantWithUser("cross-tenant-b");
    await expect(
      authService.login({ restaurantSlug: tenantB.slug, email: tenantA.email, password: tenantA.password }),
    ).rejects.toThrow();
  });
});

describe("refresh() / logout()", () => {
  it("issues a new access token and rotates the refresh token", async () => {
    const fixture = await createRestaurantWithUser("refresh-ok");
    const first = await authService.login({ restaurantSlug: fixture.slug, email: fixture.email, password: fixture.password });
    const second = await authService.refresh(first.refreshToken);

    expect(second.accessToken).toBeTruthy();
    expect(second.refreshToken).not.toBe(first.refreshToken);
    await expect(authService.refresh(first.refreshToken)).rejects.toThrow(); // rotated away, can't replay
  });

  it("rejects a refresh token after logout, and audits the logout", async () => {
    const fixture = await createRestaurantWithUser("logout-ok");
    const { refreshToken } = await authService.login({ restaurantSlug: fixture.slug, email: fixture.email, password: fixture.password });
    await authService.logout(refreshToken);
    await expect(authService.refresh(refreshToken)).rejects.toThrow();
    expect(await auditActions(fixture.restaurantId)).toEqual(["auth.logout"]);
  });

  it("logout is a silent no-op for a garbage token, and doesn't audit anything", async () => {
    await expect(authService.logout("not-a-real-token")).resolves.toBeUndefined();
  });

  it("logging out an already-revoked session again doesn't double-audit", async () => {
    const fixture = await createRestaurantWithUser("logout-twice");
    const { refreshToken } = await authService.login({ restaurantSlug: fixture.slug, email: fixture.email, password: fixture.password });
    await authService.logout(refreshToken);
    await authService.logout(refreshToken); // already revoked — silent no-op, same as a garbage token
    expect(await auditActions(fixture.restaurantId)).toEqual(["auth.logout"]);
  });

  it("rejects a garbage refresh token", async () => {
    await expect(authService.refresh("not-a-real-token")).rejects.toThrow();
  });
});

describe("password reset", () => {
  it("resets the password; the old password stops working and the new one works", async () => {
    const fixture = await createRestaurantWithUser("reset-ok");
    const requested = await authService.requestPasswordReset({ restaurantSlug: fixture.slug, email: fixture.email });
    if (requested === null) throw new Error("expected a reset token");

    await authService.resetPassword({ resetToken: requested.resetToken, newPassword: "a brand new password" });

    await expect(
      authService.login({ restaurantSlug: fixture.slug, email: fixture.email, password: fixture.password }),
    ).rejects.toThrow();
    const loginResult = await authService.login({
      restaurantSlug: fixture.slug,
      email: fixture.email,
      password: "a brand new password",
    });
    expect(loginResult.accessToken).toBeTruthy();
    expect(await auditActions(fixture.restaurantId)).toEqual(["auth.password_reset"]);
  });

  it("revokes existing sessions when the password is reset", async () => {
    const fixture = await createRestaurantWithUser("reset-revokes");
    const { refreshToken } = await authService.login({ restaurantSlug: fixture.slug, email: fixture.email, password: fixture.password });

    const requested = await authService.requestPasswordReset({ restaurantSlug: fixture.slug, email: fixture.email });
    if (requested === null) throw new Error("expected a reset token");
    await authService.resetPassword({ resetToken: requested.resetToken, newPassword: "yet another password" });

    await expect(authService.refresh(refreshToken)).rejects.toThrow();
  });

  it("a reset token can't be used twice", async () => {
    const fixture = await createRestaurantWithUser("reset-once");
    const requested = await authService.requestPasswordReset({ restaurantSlug: fixture.slug, email: fixture.email });
    if (requested === null) throw new Error("expected a reset token");

    await authService.resetPassword({ resetToken: requested.resetToken, newPassword: "password one" });
    await expect(
      authService.resetPassword({ resetToken: requested.resetToken, newPassword: "password two" }),
    ).rejects.toThrow();
  });

  it("returns null for an unknown email, without revealing anything", async () => {
    const fixture = await createRestaurantWithUser("reset-unknown-email");
    const result = await authService.requestPasswordReset({ restaurantSlug: fixture.slug, email: "nobody@example.test" });
    expect(result).toBeNull();
  });

  it("returns null for an unknown restaurant slug", async () => {
    const result = await authService.requestPasswordReset({
      restaurantSlug: `no-such-restaurant-${randomUUID()}`,
      email: "x@example.test",
    });
    expect(result).toBeNull();
  });
});
