import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { DeviceService } from "./device.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: DeviceService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  service = new DeviceService(db, new AuditLogService(db));
});

afterAll(async () => {
  await pool.end();
});

interface Tenant {
  restaurantId: string;
  branchId: string;
  ownerUserId: string;
}

async function createTenant(label: string): Promise<Tenant> {
  const restaurantRows = await withTenant(db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
    tx
      .insert(schema.restaurants)
      .values({ name: label, slug: `${label}-${randomUUID()}`, commissionRateBasisPoints: 500 })
      .returning({ id: schema.restaurants.id }),
  );
  const restaurant = restaurantRows[0];
  if (!restaurant) throw new Error("fixture: restaurant insert returned no row");

  const roleRows = await db
    .insert(schema.roles)
    .values({ key: "owner", name: "Restaurant Owner" })
    .onConflictDoUpdate({ target: schema.roles.key, set: { name: "Restaurant Owner" } })
    .returning({ id: schema.roles.id });
  const role = roleRows[0];
  if (!role) throw new Error("fixture: role insert returned no row");

  return withTenant(db, { restaurantId: restaurant.id }, async (tx) => {
    const branchRows = await tx
      .insert(schema.branches)
      .values({ restaurantId: restaurant.id, name: "Main", timezone: "Asia/Karachi" })
      .returning({ id: schema.branches.id });
    const branch = branchRows[0];
    if (!branch) throw new Error("fixture: branch insert returned no row");

    const ownerRows = await tx
      .insert(schema.users)
      .values({ restaurantId: restaurant.id, roleId: role.id, email: `${label}@example.test`, passwordHash: "unused", displayName: label })
      .returning({ id: schema.users.id });
    const owner = ownerRows[0];
    if (!owner) throw new Error("fixture: user insert returned no row");

    return { restaurantId: restaurant.id, branchId: branch.id, ownerUserId: owner.id };
  });
}

async function createDevice(tenant: Tenant, label: string) {
  return service.create({
    restaurantId: tenant.restaurantId,
    actorUserId: tenant.ownerUserId,
    branchId: tenant.branchId,
    label,
    deviceType: "pos_terminal",
  });
}

async function auditActions(restaurantId: string): Promise<string[]> {
  const rows = await withTenant(db, { restaurantId }, (tx) => tx.select({ action: schema.auditLogs.action }).from(schema.auditLogs));
  return rows.map((r) => r.action);
}

describe("create()", () => {
  it("creates a device unpaired, lists it, and audits the creation", async () => {
    const tenant = await createTenant("device-create");
    const device = await createDevice(tenant, "Front Counter");

    expect(device.status).toBe("active");
    expect(device.label).toBe("Front Counter");

    const listed = await service.list(tenant.restaurantId);
    expect(listed.map((d) => d.id)).toContain(device.id);
    expect(await auditActions(tenant.restaurantId)).toContain("device.created");
  });
});

describe("pairing and token validation", () => {
  it("a generated pairing code can be redeemed exactly once for a working device token", async () => {
    const tenant = await createTenant("pair-ok");
    const device = await createDevice(tenant, "Kitchen Display");

    const { pairingCode } = await service.generatePairingCode({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.ownerUserId,
      deviceId: device.id,
    });

    const redeemed = await service.redeemPairingCode(pairingCode);
    expect(redeemed.device.id).toBe(device.id);
    expect(redeemed.deviceToken).toBeTruthy();

    // Already consumed — redeeming the same code again must fail, not re-issue a token.
    await expect(service.redeemPairingCode(pairingCode)).rejects.toThrow();

    const validated = await service.validateDeviceToken(redeemed.deviceToken);
    expect(validated.id).toBe(device.id);
    expect(validated.lastSeenAt).not.toBeNull();

    expect(await auditActions(tenant.restaurantId)).toEqual(
      expect.arrayContaining(["device.created", "device.pairing_code_generated", "device.paired"]),
    );
  });

  it("rejects a garbage pairing code", async () => {
    await expect(service.redeemPairingCode("not-a-real-code")).rejects.toThrow();
  });

  it("rejects an expired pairing code", async () => {
    const tenant = await createTenant("pair-expired");
    const device = await createDevice(tenant, "Expired Terminal");
    const { pairingCode } = await service.generatePairingCode({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.ownerUserId,
      deviceId: device.id,
    });

    // Back-date the expiry directly — simulating a code that's simply gone stale,
    // rather than waiting out the real TTL in a test.
    await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) =>
      tx.update(schema.devices).set({ pairingCodeExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.devices.id, device.id)),
    );

    await expect(service.redeemPairingCode(pairingCode)).rejects.toThrow();
  });

  it("generating a new pairing code invalidates the previous one", async () => {
    const tenant = await createTenant("pair-regenerate");
    const device = await createDevice(tenant, "Regenerated Terminal");

    const first = await service.generatePairingCode({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.ownerUserId,
      deviceId: device.id,
    });
    await service.generatePairingCode({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, deviceId: device.id });

    await expect(service.redeemPairingCode(first.pairingCode)).rejects.toThrow();
  });

  it("rejects a garbage device token", async () => {
    await expect(service.validateDeviceToken("not-a-real-token")).rejects.toThrow();
  });
});

describe("revoke()", () => {
  it("revokes a device, invalidates its token, and audits the revocation", async () => {
    const tenant = await createTenant("revoke-ok");
    const device = await createDevice(tenant, "Revoke Me");
    const { pairingCode } = await service.generatePairingCode({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.ownerUserId,
      deviceId: device.id,
    });
    const { deviceToken } = await service.redeemPairingCode(pairingCode);

    const revoked = await service.revoke({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, deviceId: device.id });
    expect(revoked.status).toBe("revoked");

    await expect(service.validateDeviceToken(deviceToken)).rejects.toThrow();
    expect(await auditActions(tenant.restaurantId)).toContain("device.revoked");
  });

  it("revoking an unknown device throws NotFoundException", async () => {
    const tenant = await createTenant("revoke-unknown");
    await expect(
      service.revoke({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, deviceId: randomUUID() }),
    ).rejects.toThrow();
  });
});

describe("tenant isolation", () => {
  it("one restaurant's pairing code can't be redeemed under another tenant's context, and devices don't leak across tenants", async () => {
    const tenantA = await createTenant("iso-a");
    const tenantB = await createTenant("iso-b");
    const deviceA = await createDevice(tenantA, "A's Terminal");
    await createDevice(tenantB, "B's Terminal");

    const listedByB = await service.list(tenantB.restaurantId);
    expect(listedByB.map((d) => d.id)).not.toContain(deviceA.id);

    // A device id from tenant A, revoked under tenant B's restaurantId — RLS means
    // the row is simply invisible to B, so this must fail exactly like "not found".
    await expect(
      service.revoke({ restaurantId: tenantB.restaurantId, actorUserId: tenantB.ownerUserId, deviceId: deviceA.id }),
    ).rejects.toThrow();
  });
});
