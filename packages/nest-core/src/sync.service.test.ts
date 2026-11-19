import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { OfflineSaleCompletedPayload } from "@mezbaan/contracts";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { CategoriesService } from "./categories.service.js";
import { DeviceService } from "./device.service.js";
import { OfflineSaleSyncService } from "./offline-sale-sync.service.js";
import { PriceListItemsService } from "./price-list-items.service.js";
import { PriceListsService } from "./price-lists.service.js";
import { ProductsService } from "./products.service.js";
import { SyncService } from "./sync.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: SyncService;
let deviceService: DeviceService;
let categoriesService: CategoriesService;
let productsService: ProductsService;
let priceListsService: PriceListsService;
let priceListItemsService: PriceListItemsService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  service = new SyncService(db, new OfflineSaleSyncService(auditLogService));
  deviceService = new DeviceService(db, auditLogService);
  categoriesService = new CategoriesService(db, auditLogService);
  productsService = new ProductsService(db, auditLogService);
  priceListsService = new PriceListsService(db, auditLogService);
  priceListItemsService = new PriceListItemsService(db, auditLogService);
});

afterAll(async () => {
  await pool.end();
});

async function createFixture(label: string): Promise<{ restaurantId: string; branchId: string; deviceId: string; ownerUserId: string }> {
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

    const deviceRows = await tx
      .insert(schema.devices)
      .values({ restaurantId: restaurant.id, branchId: branch.id, label: `${label}-device`, deviceType: "pos_terminal" })
      .returning({ id: schema.devices.id });
    const device = deviceRows[0];
    if (!device) throw new Error("fixture: device insert returned no row");

    return { restaurantId: restaurant.id, branchId: branch.id, deviceId: device.id, ownerUserId: owner.id };
  });
}

function op(idempotencyKey: string) {
  return { id: randomUUID(), idempotencyKey, operationType: "widget.created", payload: '{"label":"a widget"}', createdAt: new Date().toISOString() };
}

async function createPricedProduct(restaurantId: string, actorUserId: string, unitPriceMinor: bigint, currency = "PKR"): Promise<{ productId: string; priceListId: string; priceListVersion: number }> {
  const category = await categoriesService.create({ restaurantId, actorUserId, name: "Burgers" });
  const product = await productsService.create({ restaurantId, actorUserId, categoryId: category.id, name: "Cheeseburger" });
  const priceList = await priceListsService.create({ restaurantId, actorUserId, name: `List-${randomUUID()}`, currency });
  await priceListItemsService.setPrice({ restaurantId, actorUserId, priceListId: priceList.id, productId: product.id, unitPriceMinor });
  const published = await priceListsService.publish({ restaurantId, actorUserId, priceListId: priceList.id });
  return { productId: product.id, priceListId: priceList.id, priceListVersion: published.version };
}

/** Mirrors exactly what apps/desktop/src-tauri/src/offline_sales.rs serializes into
 * operation_log.payload (and what sync_client.rs then sends verbatim) — this is the
 * real wire contract between the Rust client and this endpoint, not a simplified
 * stand-in for it. */
function offlineSaleOp(idempotencyKey: string, documentNumber: string, line: { productId: string; priceListId: string; priceListVersion: number }) {
  const payload: OfflineSaleCompletedPayload = {
    orderType: "takeaway",
    currency: "PKR",
    lines: [{ productId: line.productId, name: "Cheeseburger", quantity: 2, unitPriceMinor: "1500", currency: "PKR", priceListId: line.priceListId, priceListVersion: line.priceListVersion, modifiers: [] }],
    documentNumber,
    subtotalMinor: "3000",
    serviceChargeMinor: "0",
    taxMinor: "300",
    totalMinor: "3300",
    pricingMode: "exclusive",
    taxRateBasisPoints: 1000,
    serviceChargeRateBasisPoints: null,
    appliedTaxRules: [{ name: "VAT", rateBasisPoints: 1000 }],
  };
  return { id: randomUUID(), idempotencyKey, operationType: "offline_sale.completed", payload: JSON.stringify(payload), createdAt: new Date().toISOString() };
}

describe("SyncService", () => {
  it("accepts a batch and persists each operation", async () => {
    const fixture = await createFixture("sync-accept");
    const operations = [op("op-1"), op("op-2")];

    const results = await service.receiveBatch({ ...fixture, operations });

    expect(results).toEqual([
      { id: operations[0]!.id, status: "accepted" },
      { id: operations[1]!.id, status: "accepted" },
    ]);
    const stored = await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) => tx.select().from(schema.syncOperations));
    expect(stored.map((s) => s.idempotencyKey).sort()).toEqual(["op-1", "op-2"]);
  });

  it("retrying the same idempotency key accepts again without creating a duplicate row", async () => {
    const fixture = await createFixture("sync-retry");
    const operation = op("op-dup");

    await service.receiveBatch({ ...fixture, operations: [operation] });
    const retryResult = await service.receiveBatch({ ...fixture, operations: [{ ...operation, id: randomUUID() }] });

    expect(retryResult).toEqual([{ id: retryResult[0]!.id, status: "accepted" }]);
    const stored = await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) => tx.select().from(schema.syncOperations));
    expect(stored.filter((s) => s.idempotencyKey === "op-dup")).toHaveLength(1);
  });

  it("retrying with the exact same id and idempotency key (the realistic crash-resume case) also just accepts again", async () => {
    const fixture = await createFixture("sync-exact-retry");
    const operation = op("op-exact");

    await service.receiveBatch({ ...fixture, operations: [operation] });
    const retryResult = await service.receiveBatch({ ...fixture, operations: [operation] });

    expect(retryResult).toEqual([{ id: operation.id, status: "accepted" }]);
    const stored = await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) => tx.select().from(schema.syncOperations));
    expect(stored.filter((s) => s.idempotencyKey === "op-exact")).toHaveLength(1);
  });

  it("P1-31: two concurrent submissions of the same idempotency key race safely and never produce a duplicate row", async () => {
    const fixture = await createFixture("sync-concurrent-dup");
    const operation = op("op-race");

    // Both resolve concurrently rather than one awaited after the other — this is
    // what actually exercises the unique-constraint race (two terminals' retries
    // overlapping on the network), not just sequential idempotency.
    const results = await Promise.all([
      service.receiveBatch({ ...fixture, operations: [{ ...operation, id: randomUUID() }] }),
      service.receiveBatch({ ...fixture, operations: [{ ...operation, id: randomUUID() }] }),
    ]);

    expect(results[0]).toEqual([{ id: results[0]![0]!.id, status: "accepted" }]);
    expect(results[1]).toEqual([{ id: results[1]![0]!.id, status: "accepted" }]);
    const stored = await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) => tx.select().from(schema.syncOperations));
    expect(stored.filter((s) => s.idempotencyKey === "op-race")).toHaveLength(1);
  });

  it("an operation recorded under one restaurant is never visible to another's reads", async () => {
    const a = await createFixture("sync-iso-a");
    const b = await createFixture("sync-iso-b");
    await service.receiveBatch({ ...a, operations: [op("op-a")] });

    const seenByB = await withTenant(db, { restaurantId: b.restaurantId }, (tx) => tx.select().from(schema.syncOperations));
    expect(seenByB).toEqual([]);
  });
});

/**
 * P2-45 (exit-gate hardening): the "no lost or duplicated sales, totals match
 * between terminal and server" half of Phase 2's exit gate — the part that
 * genuinely couldn't be verified before this task, since nothing server-side
 * turned a synced offline sale into a real order/invoice at all. These tests
 * exercise the exact same entry point apps/desktop's Rust sync_client hits
 * (SyncService.receiveBatch), with payloads shaped exactly like what
 * offline_sales.rs actually serializes (see offlineSaleOp above) — the real
 * wire contract, not a simulation of one.
 */
describe("SyncService — offline sale sync (P2-45 exit-gate hardening)", () => {
  it("syncs an offline sale into a real order and invoice whose total matches exactly what the terminal recorded", async () => {
    const fixture = await createFixture("offline-exit-gate-ok");
    await deviceService.setDefaultActor({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, deviceId: fixture.deviceId, defaultActorUserId: fixture.ownerUserId });
    const line = await createPricedProduct(fixture.restaurantId, fixture.ownerUserId, 1500n);

    const results = await service.receiveBatch({ ...fixture, operations: [offlineSaleOp("offline-sale-1", "B1-T1-000001", line)] });
    expect(results).toEqual([{ id: results[0]!.id, status: "accepted" }]);

    const invoices = await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) => tx.select().from(schema.invoices));
    expect(invoices).toHaveLength(1);
    expect(invoices[0]?.documentNumber).toBe("B1-T1-000001");
    // The terminal's own recorded total (rule 3/4) — not re-derived here, this
    // confirms the server stored exactly what was charged, not a fresh computation.
    expect(invoices[0]?.totalMinor).toBe(3300n);

    const orders = await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) => tx.select().from(schema.orders));
    expect(orders).toHaveLength(1);
    expect(orders[0]?.status).toBe("closed");
  });

  it("a network-interruption retry (same idempotency key resent) never creates a second order or invoice", async () => {
    const fixture = await createFixture("offline-exit-gate-retry");
    await deviceService.setDefaultActor({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, deviceId: fixture.deviceId, defaultActorUserId: fixture.ownerUserId });
    const line = await createPricedProduct(fixture.restaurantId, fixture.ownerUserId, 1500n);
    const operation = offlineSaleOp("offline-sale-retry", "B1-T1-000002", line);

    // First attempt "succeeds" from the client's perspective but the response
    // never arrives (a real-world internet outage mid-request) — the terminal
    // retries the exact same operation on its next sync cycle.
    await service.receiveBatch({ ...fixture, operations: [operation] });
    const retryResult = await service.receiveBatch({ ...fixture, operations: [operation] });

    expect(retryResult).toEqual([{ id: operation.id, status: "accepted" }]);
    const invoices = await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) => tx.select().from(schema.invoices));
    expect(invoices).toHaveLength(1);
    const orders = await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) => tx.select().from(schema.orders));
    expect(orders).toHaveLength(1);
  });

  it("rejects an offline sale from a device with no default actor, then succeeds once one is configured — the real admin-fixes-it-and-the-next-sync-succeeds path", async () => {
    const fixture = await createFixture("offline-exit-gate-unconfigured");
    const line = await createPricedProduct(fixture.restaurantId, fixture.ownerUserId, 1500n);
    const operation = offlineSaleOp("offline-sale-unconfigured", "B1-T1-000003", line);

    const firstAttempt = await service.receiveBatch({ ...fixture, operations: [operation] });
    expect(firstAttempt[0]?.status).toBe("rejected");
    expect(firstAttempt[0]?.reason).toMatch(/default actor/);
    expect(await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) => tx.select().from(schema.invoices))).toHaveLength(0);

    await deviceService.setDefaultActor({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, deviceId: fixture.deviceId, defaultActorUserId: fixture.ownerUserId });
    const secondAttempt = await service.receiveBatch({ ...fixture, operations: [operation] });
    expect(secondAttempt[0]?.status).toBe("accepted");
    expect(await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) => tx.select().from(schema.invoices))).toHaveLength(1);
  });
});
