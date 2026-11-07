import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictException, UnauthorizedException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { verifyPassword } from "./password.js";
import { UserInvitationService } from "./user-invitation.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: UserInvitationService;
let ownerRoleId: string;

beforeAll(async () => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  service = new UserInvitationService(db, new AuditLogService(db), {});

  const roleRows = await db
    .insert(schema.roles)
    .values({ key: "owner", name: "Restaurant Owner" })
    .onConflictDoUpdate({ target: schema.roles.key, set: { name: "Restaurant Owner" } })
    .returning({ id: schema.roles.id });
  const role = roleRows[0];
  if (!role) throw new Error("fixture: owner role insert returned no row");
  ownerRoleId = role.id;
});

afterAll(async () => {
  await pool.end();
});

interface Tenant {
  restaurantId: string;
  ownerUserId: string;
  ownerEmail: string;
}

async function createRestaurant(label: string): Promise<Tenant> {
  const restaurantRows = await withTenant(db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
    tx
      .insert(schema.restaurants)
      .values({ name: label, slug: `${label}-${randomUUID()}`, commissionRateBasisPoints: 500 })
      .returning({ id: schema.restaurants.id }),
  );
  const restaurant = restaurantRows[0];
  if (!restaurant) throw new Error("fixture: restaurant insert returned no row");

  const ownerEmail = `${label}-${randomUUID()}@example.test`;
  const ownerRows = await withTenant(db, { restaurantId: restaurant.id }, (tx) =>
    tx
      .insert(schema.users)
      .values({ restaurantId: restaurant.id, roleId: ownerRoleId, email: ownerEmail, passwordHash: "unused", displayName: label })
      .returning({ id: schema.users.id }),
  );
  const owner = ownerRows[0];
  if (!owner) throw new Error("fixture: user insert returned no row");

  return { restaurantId: restaurant.id, ownerUserId: owner.id, ownerEmail };
}

describe("UserInvitationService.invite() / acceptInvite()", () => {
  it("invites a user, accepts the invite, and the new account can verify its password", async () => {
    const tenant = await createRestaurant("invite-ok");
    const email = `invitee-${randomUUID()}@example.test`;

    const { inviteToken } = await service.invite({
      restaurantId: tenant.restaurantId,
      invitedByUserId: tenant.ownerUserId,
      email,
      roleKey: "cashier",
    });
    expect(inviteToken).toBeTruthy();

    await service.acceptInvite({ inviteToken, displayName: "New Cashier", password: "a long enough password" });

    const users = await service.listUsers(tenant.restaurantId);
    const created = users.find((u) => u.email === email);
    expect(created?.roleKey).toBe("cashier");

    const userRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) =>
      tx.select({ passwordHash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.email, email)),
    );
    expect(await verifyPassword("a long enough password", userRows[0]?.passwordHash ?? "")).toBe(true);
  });

  it("rejects inviting an email that already belongs to an active user in the restaurant", async () => {
    const tenant = await createRestaurant("invite-existing-user");

    await expect(
      service.invite({ restaurantId: tenant.restaurantId, invitedByUserId: tenant.ownerUserId, email: tenant.ownerEmail, roleKey: "cashier" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("rejects an invite token that's already been accepted (can't be replayed)", async () => {
    const tenant = await createRestaurant("invite-replay");
    const { inviteToken } = await service.invite({
      restaurantId: tenant.restaurantId,
      invitedByUserId: tenant.ownerUserId,
      email: `invite-replay-${randomUUID()}@example.test`,
      roleKey: "cashier",
    });
    await service.acceptInvite({ inviteToken, displayName: "First Accept", password: "a long enough password" });

    await expect(
      service.acceptInvite({ inviteToken, displayName: "Second Accept", password: "a different password" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects a garbage invite token", async () => {
    await expect(
      service.acceptInvite({ inviteToken: "not-a-real-token", displayName: "Nobody", password: "a long enough password" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("an invitation sent under one tenant is never visible via another tenant's pending list", async () => {
    const tenantA = await createRestaurant("invite-iso-a");
    const tenantB = await createRestaurant("invite-iso-b");
    await service.invite({
      restaurantId: tenantA.restaurantId,
      invitedByUserId: tenantA.ownerUserId,
      email: `invite-iso-${randomUUID()}@example.test`,
      roleKey: "cashier",
    });

    const seenByB = await service.listPendingInvitations(tenantB.restaurantId);
    expect(seenByB).toEqual([]);
  });
});
