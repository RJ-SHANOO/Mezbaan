import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { OfflineSaleCompletedPayload } from "@mezbaan/contracts";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { CategoriesService } from "./categories.service.js";
import { DeviceService } from "./device.service.js";
import { OfflineSaleSyncService } from "./offline-sale-sync.service.js";
import { OutboxService } from "./outbox.service.js";
import { OutboxWorkerService, type OutboxRecord } from "./outbox-worker.service.js";
import { PriceListItemsService } from "./price-list-items.service.js";
import { PriceListsService } from "./price-lists.service.js";
import { ProductsService } from "./products.service.js";
import { ReconciliationService } from "./reconciliation.service.js";
import { ServiceChargeSettingsService } from "./service-charge-settings.service.js";
import { SyncService } from "./sync.service.js";
import { TaxCalculationService } from "./tax-calculation.service.js";
import { TaxRulesService } from "./tax-rules.service.js";
import { TaxSettingsService } from "./tax-settings.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let syncService: SyncService;
let deviceService: DeviceService;
let categoriesService: CategoriesService;
let productsService: ProductsService;
let priceListsService: PriceListsService;
let priceListItemsService: PriceListItemsService;
let reconciliationService: ReconciliationService;
let outboxWorkerService: OutboxWorkerService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  const taxRulesService = new TaxRulesService(db, auditLogService);
  const taxSettingsService = new TaxSettingsService(db, auditLogService);
  const serviceChargeSettingsService = new ServiceChargeSettingsService(db, auditLogService);
  const taxCalculationService = new TaxCalculationService(taxRulesService, taxSettingsService, serviceChargeSettingsService);
  const outboxService = new OutboxService(db);

  syncService = new SyncService(db, new OfflineSaleSyncService(auditLogService, outboxService));
  deviceService = new DeviceService(db, auditLogService);
  categoriesService = new CategoriesService(db, auditLogService);
  productsService = new ProductsService(db, auditLogService);
  priceListsService = new PriceListsService(db, auditLogService);
  priceListItemsService = new PriceListItemsService(db, auditLogService);
  reconciliationService = new ReconciliationService(db, taxCalculationService);

  outboxWorkerService = new OutboxWorkerService(db, {});
  outboxWorkerService.registerHandler("invoice.generated", (record: OutboxRecord) => {
    const payload = record.payload as { invoiceId?: unknown };
    if (typeof payload.invoiceId !== "string") throw new Error("invoice.generated event has no invoiceId");
    return reconciliationService.reconcileInvoice({ restaurantId: record.restaurantId, invoiceId: payload.invoiceId });
  });
});

afterAll(async () => {
  await pool.end();
});

/** This Postgres instance is shared across every test file in this session,
 * so the outbox table can carry a real backlog of older rows (including
 * permanently-failing dead-letter fixtures from outbox-worker.service.test.ts)
 * ahead of whatever this test just enqueued. Draining in a loop — rather than
 * trusting a single processBatch() call — is what a real always-polling
 * worker process does too, not a test-only workaround. */
async function drainOutbox(maxIterations = 50): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    const summary = await outboxWorkerService.processBatch();
    if (summary.claimed === 0) return;
  }
}

interface Fixture {
  restaurantId: string;
  branchId: string;
  deviceId: string;
  ownerUserId: string;
}

async function createFixture(label: string): Promise<Fixture> {
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
      .values({ restaurantId: restaurant.id, branchId: branch.id, label: "Till 1", deviceType: "pos_terminal" })
      .returning({ id: schema.devices.id });
    const device = deviceRows[0];
    if (!device) throw new Error("fixture: device insert returned no row");

    return { restaurantId: restaurant.id, branchId: branch.id, deviceId: device.id, ownerUserId: owner.id };
  });
}

async function createPricedProduct(restaurantId: string, actorUserId: string, unitPriceMinor: bigint): Promise<{ productId: string; priceListId: string; priceListVersion: number }> {
  const category = await categoriesService.create({ restaurantId, actorUserId, name: "Burgers" });
  const product = await productsService.create({ restaurantId, actorUserId, categoryId: category.id, name: "Cheeseburger" });
  const priceList = await priceListsService.create({ restaurantId, actorUserId, name: `List-${randomUUID()}`, currency: "PKR" });
  await priceListItemsService.setPrice({ restaurantId, actorUserId, priceListId: priceList.id, productId: product.id, unitPriceMinor });
  const published = await priceListsService.publish({ restaurantId, actorUserId, priceListId: priceList.id });
  return { productId: product.id, priceListId: priceList.id, priceListVersion: published.version };
}

function offlineSaleOp(
  idempotencyKey: string,
  documentNumber: string,
  line: { productId: string; priceListId: string; priceListVersion: number },
  overrides: Partial<OfflineSaleCompletedPayload> = {},
) {
  const payload: OfflineSaleCompletedPayload = {
    orderType: "takeaway",
    currency: "PKR",
    lines: [{ productId: line.productId, name: "Cheeseburger", quantity: 2, unitPriceMinor: "1500", currency: "PKR", priceListId: line.priceListId, priceListVersion: line.priceListVersion, modifiers: [] }],
    documentNumber,
    subtotalMinor: "3000",
    serviceChargeMinor: "0",
    taxMinor: "0",
    totalMinor: "3000",
    pricingMode: "exclusive",
    taxRateBasisPoints: 0,
    serviceChargeRateBasisPoints: null,
    appliedTaxRules: [],
    ...overrides,
  };
  return { id: randomUUID(), idempotencyKey, operationType: "offline_sale.completed", payload: JSON.stringify(payload), createdAt: new Date().toISOString() };
}

/**
 * P2-45/P2-46 (Phase 2 exit gate): "a pilot branch runs full service,
 * including an internet outage and a hub restart, with no lost or
 * duplicated sales. Totals match between terminals and server." A live
 * restaurant pilot is the only way to fully verify that in reality, but this
 * exercises the one part of it that lives entirely in this codebase and was
 * genuinely unverifiable before this session's work: offline sale → synced
 * over the real `/sync/operations` path (SyncService.receiveBatch) → a real
 * server-side order/invoice → independently recalculated by the exact same
 * reconciliation machinery (P2-26) a server-priced sale already goes
 * through. Hub-restart resilience (reconnect, bounded outbox replay) is
 * separately unit-tested at the Rust level (P2-38/P2-39) — this test's job
 * is specifically the terminal-to-server totals axis.
 */
describe("Offline sale exit-gate simulation: sync -> real invoice -> reconciliation", () => {
  it("a correctly-priced offline sale reconciles clean — no mismatch flag, because the terminal's totals genuinely match the server's own recalculation", async () => {
    const fixture = await createFixture("exit-gate-clean");
    await deviceService.setDefaultActor({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, deviceId: fixture.deviceId, defaultActorUserId: fixture.ownerUserId });
    // No tax rules configured for this restaurant — the server's own fresh
    // recalculation will expect 0% tax, exactly matching the terminal's report.
    const line = await createPricedProduct(fixture.restaurantId, fixture.ownerUserId, 1500n);

    const results = await syncService.receiveBatch({ ...fixture, operations: [offlineSaleOp("exit-gate-clean-sale", "B1-T1-900001", line)] });
    expect(results[0]?.status).toBe("accepted");

    const invoice = (await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) => tx.select().from(schema.invoices)))[0];
    expect(invoice?.totalMinor).toBe(3000n);

    await drainOutbox();

    const flags = await reconciliationService.listFlags({ restaurantId: fixture.restaurantId });
    expect(flags.items.filter((f) => f.invoiceId === invoice?.id)).toHaveLength(0);
  });

  it("an offline sale with a stale/wrong tax rate gets flagged by the exact same reconciliation an online sale would — never silently corrected", async () => {
    const fixture = await createFixture("exit-gate-mismatch");
    await deviceService.setDefaultActor({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, deviceId: fixture.deviceId, defaultActorUserId: fixture.ownerUserId });
    // Still no tax rules configured server-side — so the server's fresh
    // recalculation still expects 0% tax. This terminal, though, reports as
    // if a 10% tax applied (e.g. its locally cached tax config went stale
    // while offline for a long stretch) — a real, realistic mismatch.
    const line = await createPricedProduct(fixture.restaurantId, fixture.ownerUserId, 1500n);

    const results = await syncService.receiveBatch({
      ...fixture,
      operations: [
        offlineSaleOp("exit-gate-mismatch-sale", "B1-T1-900002", line, {
          taxMinor: "300",
          totalMinor: "3300",
          taxRateBasisPoints: 1000,
          appliedTaxRules: [{ name: "VAT (stale)", rateBasisPoints: 1000 }],
        }),
      ],
    });
    expect(results[0]?.status).toBe("accepted"); // syncing and recording the sale always succeeds — rule 6/14, nothing blocks the sale itself

    const invoice = (await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) => tx.select().from(schema.invoices)))[0];
    expect(invoice?.totalMinor).toBe(3300n); // the recorded sale is never silently changed (rule 3/4)

    await drainOutbox();

    const flags = await reconciliationService.listFlags({ restaurantId: fixture.restaurantId });
    const flag = flags.items.find((f) => f.invoiceId === invoice?.id);
    expect(flag).toBeDefined();
    expect(flag?.mismatchedFields).toContain("tax");
    expect(flag?.mismatchedFields).toContain("total");
    expect(flag?.storedTotalMinor).toBe(3300n); // what the terminal actually charged
    expect(flag?.expectedTotalMinor).toBe(3000n); // what the server independently recalculated

    // The invoice itself is still exactly what was charged — reconciliation
    // is a pointer at the problem, never a silent correction of the record.
    const invoiceAfter = (await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) => tx.select().from(schema.invoices)))[0];
    expect(invoiceAfter?.totalMinor).toBe(3300n);
  });
});
