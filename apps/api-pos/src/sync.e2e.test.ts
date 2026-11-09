import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import "reflect-metadata";
import fastifyCompress from "@fastify/compress";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Pool } from "pg";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService, DATABASE, DeviceService, DEV_JWT_SECRET, PermissionGuard, PermissionsService, TenantContextGuard } from "@mezbaan/nest-core";
import { AppModule } from "./app.module.js";

/** Section 8 / P1-26: the sync endpoint is device-token authenticated, not
 * user-JWT, so it needs its own HTTP-level tenant-isolation coverage rather than
 * reusing api-admin's tenant-isolation.e2e.test.ts pattern as-is. */
const SECRET = process.env.JWT_SECRET ?? DEV_JWT_SECRET;
const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let app: NestFastifyApplication;
let pool: Pool;
let db: Database;
let deviceService: DeviceService;

beforeAll(async () => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  deviceService = new DeviceService(db, new AuditLogService(db));

  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  // P1-35: matches main.ts's real bootstrap — the sync client gzips every batch,
  // so this needs to be registered here too for the compressed-body test below to
  // exercise the real decompression path, not just the guards/controller.
  await app.register(fastifyCompress);
  app.useGlobalGuards(
    new TenantContextGuard({ secret: SECRET }),
    new PermissionGuard(new PermissionsService(app.get<Database>(DATABASE)), app.get(Reflector)),
  );
  await app.init();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

async function createPairedDevice(label: string): Promise<{ restaurantId: string; deviceToken: string }> {
  const restaurantRows = await withTenant(db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
    tx
      .insert(schema.restaurants)
      .values({ name: label, slug: `${label}-${randomUUID()}`, commissionRateBasisPoints: 500 })
      .returning({ id: schema.restaurants.id }),
  );
  const restaurantId = restaurantRows[0]?.id;
  if (!restaurantId) throw new Error("fixture: restaurant insert returned no row");

  // deviceService.create/generatePairingCode each open their own withTenant
  // transaction — this one must commit (by returning) before any of those run, or
  // they won't see the branch/user rows yet.
  const { branchId, ownerUserId } = await withTenant(db, { restaurantId }, async (tx) => {
    const branchRows = await tx.insert(schema.branches).values({ restaurantId, name: "Main", timezone: "Asia/Karachi" }).returning({ id: schema.branches.id });
    const branchId = branchRows[0]?.id;
    if (!branchId) throw new Error("fixture: branch insert returned no row");

    const ownerRows = await tx
      .insert(schema.users)
      .values({ restaurantId, roleId: await ownerRoleId(), email: `${label}@example.test`, passwordHash: "unused", displayName: label })
      .returning({ id: schema.users.id });
    const ownerUserId = ownerRows[0]?.id;
    if (!ownerUserId) throw new Error("fixture: user insert returned no row");

    return { branchId, ownerUserId };
  });

  const device = await deviceService.create({ restaurantId, actorUserId: ownerUserId, branchId, label: `${label}-device`, deviceType: "pos_terminal" });
  const { pairingCode } = await deviceService.generatePairingCode({ restaurantId, actorUserId: ownerUserId, deviceId: device.id });
  const { deviceToken } = await deviceService.redeemPairingCode(pairingCode);
  return { restaurantId, deviceToken };
}

async function ownerRoleId(): Promise<string> {
  const rows = await db.insert(schema.roles).values({ key: "owner", name: "Restaurant Owner" }).onConflictDoUpdate({ target: schema.roles.key, set: { name: "Restaurant Owner" } }).returning({ id: schema.roles.id });
  const id = rows[0]?.id;
  if (!id) throw new Error("fixture: role insert returned no row");
  return id;
}

function operation(idempotencyKey: string) {
  return { id: randomUUID(), idempotencyKey, operationType: "widget.created", payload: '{"label":"a widget"}', createdAt: new Date().toISOString() };
}

describe("sync — HTTP tenant isolation (api-pos)", () => {
  it("a paired device can sync a batch of operations (positive control)", async () => {
    const { deviceToken } = await createPairedDevice("sync-ok");
    const operations = [operation("op-1"), operation("op-2")];

    const response = await app.inject({
      method: "POST",
      url: "/sync/operations",
      headers: { "x-device-token": deviceToken },
      payload: { operations },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<{ results: Array<{ id: string; status: string }> }>().results).toEqual([
      { id: operations[0]!.id, status: "accepted" },
      { id: operations[1]!.id, status: "accepted" },
    ]);
  });

  it("P1-35: accepts a gzip-compressed batch (the real sync client's wire format)", async () => {
    const { deviceToken } = await createPairedDevice("sync-gzip");
    const operations = [operation("op-gzip-1")];
    const compressedBody = gzipSync(JSON.stringify({ operations }));

    const response = await app.inject({
      method: "POST",
      url: "/sync/operations",
      headers: { "x-device-token": deviceToken, "content-type": "application/json", "content-encoding": "gzip" },
      payload: compressedBody,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<{ results: Array<{ id: string; status: string }> }>().results).toEqual([
      { id: operations[0]!.id, status: "accepted" },
    ]);
  });

  it("retrying the same batch (idempotency key) still returns accepted, no duplicate", async () => {
    const { deviceToken, restaurantId } = await createPairedDevice("sync-retry");
    const op = operation("op-retry");

    await app.inject({ method: "POST", url: "/sync/operations", headers: { "x-device-token": deviceToken }, payload: { operations: [op] } });
    const retry = await app.inject({ method: "POST", url: "/sync/operations", headers: { "x-device-token": deviceToken }, payload: { operations: [op] } });

    expect(retry.statusCode).toBe(201);
    expect(retry.json<{ results: Array<{ status: string }> }>().results).toEqual([{ id: op.id, status: "accepted" }]);

    const stored = await withTenant(db, { restaurantId }, (tx) => tx.select().from(schema.syncOperations));
    expect(stored.filter((s) => s.idempotencyKey === "op-retry")).toHaveLength(1);
  });

  it("rejects a sync request with no device token or a garbage one", async () => {
    const noToken = await app.inject({ method: "POST", url: "/sync/operations", payload: { operations: [operation("op-x")] } });
    expect(noToken.statusCode).toBe(401);

    const garbage = await app.inject({ method: "POST", url: "/sync/operations", headers: { "x-device-token": "not-a-real-token" }, payload: { operations: [operation("op-y")] } });
    expect(garbage.statusCode).toBe(401);
  });

  it("rejects an empty operations array or a malformed operation", async () => {
    const { deviceToken } = await createPairedDevice("sync-bad-body");

    const empty = await app.inject({ method: "POST", url: "/sync/operations", headers: { "x-device-token": deviceToken }, payload: { operations: [] } });
    expect(empty.statusCode).toBe(400);

    const malformed = await app.inject({
      method: "POST",
      url: "/sync/operations",
      headers: { "x-device-token": deviceToken },
      payload: { operations: [{ id: "not-a-uuid" }] },
    });
    expect(malformed.statusCode).toBe(400);
  });

  it("one device's token can never make its operations show up under another restaurant's data", async () => {
    const deviceA = await createPairedDevice("sync-iso-a");
    const deviceB = await createPairedDevice("sync-iso-b");

    await app.inject({ method: "POST", url: "/sync/operations", headers: { "x-device-token": deviceA.deviceToken }, payload: { operations: [operation("op-a")] } });

    const seenByB = await withTenant(db, { restaurantId: deviceB.restaurantId }, (tx) => tx.select().from(schema.syncOperations));
    expect(seenByB).toEqual([]);
  });
});
