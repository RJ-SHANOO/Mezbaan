import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { CategoriesService } from "./categories.service.js";
import { DeviceService } from "./device.service.js";
import { InvoicesService } from "./invoices.service.js";
import { OrderItemsService } from "./order-items.service.js";
import { OrdersService } from "./orders.service.js";
import { PriceListItemsService } from "./price-list-items.service.js";
import { PriceListsService } from "./price-lists.service.js";
import { PriceResolutionService } from "./price-resolution.service.js";
import { ProductsService } from "./products.service.js";
import { ReconciliationService } from "./reconciliation.service.js";
import { ServiceChargeSettingsService } from "./service-charge-settings.service.js";
import { TaxCalculationService } from "./tax-calculation.service.js";
import { TaxRulesService } from "./tax-rules.service.js";
import { TaxSettingsService } from "./tax-settings.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: ReconciliationService;
let invoicesService: InvoicesService;
let ordersService: OrdersService;
let orderItemsService: OrderItemsService;
let deviceService: DeviceService;
let categoriesService: CategoriesService;
let productsService: ProductsService;
let priceListsService: PriceListsService;
let priceListItemsService: PriceListItemsService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  const priceResolutionService = new PriceResolutionService(db);
  orderItemsService = new OrderItemsService(db, auditLogService, priceResolutionService);
  ordersService = new OrdersService(db, auditLogService, orderItemsService);
  deviceService = new DeviceService(db, auditLogService);
  categoriesService = new CategoriesService(db, auditLogService);
  productsService = new ProductsService(db, auditLogService);
  priceListsService = new PriceListsService(db, auditLogService);
  priceListItemsService = new PriceListItemsService(db, auditLogService);
  const taxRulesService = new TaxRulesService(db, auditLogService);
  const taxSettingsService = new TaxSettingsService(db, auditLogService);
  const serviceChargeSettingsService = new ServiceChargeSettingsService(db, auditLogService);
  const taxCalculationService = new TaxCalculationService(taxRulesService, taxSettingsService, serviceChargeSettingsService);
  invoicesService = new InvoicesService(db, auditLogService, taxCalculationService);
  service = new ReconciliationService(db, taxCalculationService);
});

afterAll(async () => {
  await pool.end();
});

async function createRestaurant(label: string): Promise<{ restaurantId: string; ownerUserId: string }> {
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

  const ownerRows = await withTenant(db, { restaurantId: restaurant.id }, (tx) =>
    tx
      .insert(schema.users)
      .values({ restaurantId: restaurant.id, roleId: role.id, email: `${label}@example.test`, passwordHash: "unused", displayName: label })
      .returning({ id: schema.users.id }),
  );
  const owner = ownerRows[0];
  if (!owner) throw new Error("fixture: user insert returned no row");

  return { restaurantId: restaurant.id, ownerUserId: owner.id };
}

async function createBranch(restaurantId: string): Promise<string> {
  const rows = await withTenant(db, { restaurantId }, (tx) =>
    tx.insert(schema.branches).values({ restaurantId, name: "Main", timezone: "Asia/Karachi" }).returning({ id: schema.branches.id }),
  );
  const branch = rows[0];
  if (!branch) throw new Error("fixture: branch insert returned no row");
  return branch.id;
}

async function createPricedProduct(restaurantId: string, actorUserId: string, unitPriceMinor: bigint): Promise<{ productId: string; priceListId: string }> {
  const category = await categoriesService.create({ restaurantId, actorUserId, name: "Burgers" });
  const product = await productsService.create({ restaurantId, actorUserId, categoryId: category.id, name: "Cheeseburger" });
  const priceList = await priceListsService.create({ restaurantId, actorUserId, name: `List-${randomUUID()}`, currency: "PKR" });
  await priceListItemsService.setPrice({ restaurantId, actorUserId, priceListId: priceList.id, productId: product.id, unitPriceMinor });
  await priceListsService.publish({ restaurantId, actorUserId, priceListId: priceList.id });
  return { productId: product.id, priceListId: priceList.id };
}

interface Tenant {
  restaurantId: string;
  ownerUserId: string;
}

/** Opens a takeaway order, adds one or more priced items, closes it, and returns both the
 * orderId and the item ids in the same order they were added — the common starting point
 * for generating an invoice to then reconcile. */
async function createClosedOrderWithItems(tenant: Tenant, branchId: string, unitPricesMinor: bigint[]): Promise<{ orderId: string; itemIds: string[] }> {
  const order = await ordersService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "takeaway", currency: "PKR" });
  const itemIds: string[] = [];
  for (const unitPriceMinor of unitPricesMinor) {
    const { productId } = await createPricedProduct(tenant.restaurantId, tenant.ownerUserId, unitPriceMinor);
    const item = await orderItemsService.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId: order.id, productId });
    itemIds.push(item.id);
  }
  await ordersService.close({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId });
  return { orderId: order.id, itemIds };
}

async function createDevice(tenant: Tenant, branchId: string): Promise<string> {
  const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
  return device.id;
}

async function listFlagsForInvoice(restaurantId: string, invoiceId: string): Promise<Array<typeof schema.invoiceReconciliationFlags.$inferSelect>> {
  return withTenant(db, { restaurantId }, (tx) => tx.select().from(schema.invoiceReconciliationFlags).where(eq(schema.invoiceReconciliationFlags.invoiceId, invoiceId)));
}

describe("ReconciliationService.reconcileInvoice", () => {
  it("flags nothing for a correctly generated invoice", async () => {
    const tenant = await createRestaurant("reconcile-happy-path");
    const branchId = await createBranch(tenant.restaurantId);
    const deviceId = await createDevice(tenant, branchId);
    const { orderId } = await createClosedOrderWithItems(tenant, branchId, [10_000n]);
    const invoice = await invoicesService.generate({ restaurantId: tenant.restaurantId, orderId, deviceId, actorUserId: tenant.ownerUserId });

    await service.reconcileInvoice({ restaurantId: tenant.restaurantId, invoiceId: invoice.id });

    const flags = await listFlagsForInvoice(tenant.restaurantId, invoice.id);
    expect(flags).toHaveLength(0);
  });

  it("flags a mismatch when an order item is linked to an already-generated invoice after the fact", async () => {
    const tenant = await createRestaurant("reconcile-mismatch");
    const branchId = await createBranch(tenant.restaurantId);
    const deviceId = await createDevice(tenant, branchId);
    const { orderId } = await createClosedOrderWithItems(tenant, branchId, [10_000n]);
    const invoice = await invoicesService.generate({ restaurantId: tenant.restaurantId, orderId, deviceId, actorUserId: tenant.ownerUserId });

    // Simulates a real bug class this check exists to catch: a row that ends up
    // linked to an already-generated invoice without that invoice's own totals
    // ever being recomputed — something application code should never do, but
    // the whole point of an independent server-side recalculation (rule 3) is
    // to catch it anyway, not just trust the stored numbers.
    const { productId, priceListId } = await createPricedProduct(tenant.restaurantId, tenant.ownerUserId, 2_500n);
    await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) =>
      tx.insert(schema.orderItems).values({
        restaurantId: tenant.restaurantId,
        orderId,
        productId,
        quantity: 1,
        unitPriceMinor: 2_500n,
        currency: "PKR",
        priceListId,
        priceListVersion: 1,
        invoiceId: invoice.id,
      }),
    );

    await service.reconcileInvoice({ restaurantId: tenant.restaurantId, invoiceId: invoice.id });

    const flags = await listFlagsForInvoice(tenant.restaurantId, invoice.id);
    expect(flags).toHaveLength(1);
    const flag = flags[0]!;
    expect(flag.storedSubtotalMinor).toBe(10_000n);
    expect(flag.expectedSubtotalMinor).toBe(12_500n);
    expect(flag.storedTotalMinor).toBe(10_000n);
    expect(flag.expectedTotalMinor).toBe(12_500n);
    expect(flag.mismatchedFields.split(",")).toEqual(expect.arrayContaining(["subtotal", "total"]));
  });

  it("honors a bill-level discount recorded on the invoice rather than treating it as a mismatch", async () => {
    const tenant = await createRestaurant("reconcile-bill-discount");
    const branchId = await createBranch(tenant.restaurantId);
    const deviceId = await createDevice(tenant, branchId);
    const { orderId } = await createClosedOrderWithItems(tenant, branchId, [10_000n]);
    // Bill-level discount set directly — orders isn't one of rule 4's revoked
    // append-only tables, so this is a plain UPDATE, same as DiscountsService
    // would do; going straight to the row keeps this test from needing to
    // construct DiscountsService just to set two columns.
    await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) =>
      tx.update(schema.orders).set({ discountPercentBasisPoints: 1000 }).where(eq(schema.orders.id, orderId)),
    );

    const invoice = await invoicesService.generate({ restaurantId: tenant.restaurantId, orderId, deviceId, actorUserId: tenant.ownerUserId });
    expect(invoice.subtotalMinor).toBe(9_000n); // 10% off 10,000

    await service.reconcileInvoice({ restaurantId: tenant.restaurantId, invoiceId: invoice.id });

    const flags = await listFlagsForInvoice(tenant.restaurantId, invoice.id);
    expect(flags).toHaveLength(0);
  });

  it("a split invoice is reconciled against only its own linked items, not the whole order", async () => {
    const tenant = await createRestaurant("reconcile-split");
    const branchId = await createBranch(tenant.restaurantId);
    const deviceId = await createDevice(tenant, branchId);
    const { orderId, itemIds } = await createClosedOrderWithItems(tenant, branchId, [10_000n, 5_000n]);

    const invoice = await invoicesService.generate({ restaurantId: tenant.restaurantId, orderId, deviceId, actorUserId: tenant.ownerUserId, itemIds: [itemIds[0]!] });
    expect(invoice.subtotalMinor).toBe(10_000n);

    await service.reconcileInvoice({ restaurantId: tenant.restaurantId, invoiceId: invoice.id });

    const flags = await listFlagsForInvoice(tenant.restaurantId, invoice.id);
    expect(flags).toHaveLength(0);
  });

  it("throws (so the outbox retries) when the invoice doesn't exist", async () => {
    const tenant = await createRestaurant("reconcile-missing-invoice");
    await expect(service.reconcileInvoice({ restaurantId: tenant.restaurantId, invoiceId: randomUUID() })).rejects.toThrow();
  });
});

describe("InvoicesService.generate — enqueues a reconciliation job (P2-26)", () => {
  it("writes an invoice.generated outbox row in the same transaction as the invoice", async () => {
    const auditLogService = new AuditLogService(db);
    const taxRulesService = new TaxRulesService(db, auditLogService);
    const taxSettingsService = new TaxSettingsService(db, auditLogService);
    const serviceChargeSettingsService = new ServiceChargeSettingsService(db, auditLogService);
    const taxCalculationService = new TaxCalculationService(taxRulesService, taxSettingsService, serviceChargeSettingsService);
    const { OutboxService } = await import("./outbox.service.js");
    const outboxService = new OutboxService(db);
    const invoicesServiceWithOutbox = new InvoicesService(db, auditLogService, taxCalculationService, outboxService);

    const tenant = await createRestaurant("reconcile-outbox-producer");
    const branchId = await createBranch(tenant.restaurantId);
    const deviceId = await createDevice(tenant, branchId);
    const { orderId } = await createClosedOrderWithItems(tenant, branchId, [10_000n]);

    const invoice = await invoicesServiceWithOutbox.generate({ restaurantId: tenant.restaurantId, orderId, deviceId, actorUserId: tenant.ownerUserId });

    const outboxRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.outbox).where(eq(schema.outbox.aggregateId, invoice.id)));
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]!.eventType).toBe("invoice.generated");
    expect(outboxRows[0]!.aggregateType).toBe("invoice");
    expect(outboxRows[0]!.payload).toEqual({ invoiceId: invoice.id });
  });
});

describe("ReconciliationService.listFlags", () => {
  it("returns a tenant's own flags, newest first, respecting limit and an optional branchId filter", async () => {
    const tenant = await createRestaurant("reconcile-list-flags");
    const branchA = await createBranch(tenant.restaurantId);
    const branchB = await createBranch(tenant.restaurantId);
    const deviceA = await createDevice(tenant, branchA);
    const deviceB = await createDevice(tenant, branchB);

    async function flaggedInvoiceId(branchId: string, deviceId: string): Promise<string> {
      const { orderId } = await createClosedOrderWithItems(tenant, branchId, [10_000n]);
      const invoice = await invoicesService.generate({ restaurantId: tenant.restaurantId, orderId, deviceId, actorUserId: tenant.ownerUserId });
      const { productId, priceListId } = await createPricedProduct(tenant.restaurantId, tenant.ownerUserId, 1_000n);
      await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) =>
        tx.insert(schema.orderItems).values({
          restaurantId: tenant.restaurantId,
          orderId,
          productId,
          quantity: 1,
          unitPriceMinor: 1_000n,
          currency: "PKR",
          priceListId,
          priceListVersion: 1,
          invoiceId: invoice.id,
        }),
      );
      await service.reconcileInvoice({ restaurantId: tenant.restaurantId, invoiceId: invoice.id });
      return invoice.id;
    }

    const invoiceA = await flaggedInvoiceId(branchA, deviceA);
    const invoiceB = await flaggedInvoiceId(branchB, deviceB);

    const allFlags = await service.listFlags({ restaurantId: tenant.restaurantId });
    const allIds = allFlags.map((flag) => flag.invoiceId);
    expect(allIds).toContain(invoiceA);
    expect(allIds).toContain(invoiceB);

    const branchAFlags = await service.listFlags({ restaurantId: tenant.restaurantId, branchId: branchA });
    expect(branchAFlags.map((flag) => flag.invoiceId)).toEqual([invoiceA]);

    const limited = await service.listFlags({ restaurantId: tenant.restaurantId, limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it("never returns another tenant's flags", async () => {
    const tenantA = await createRestaurant("reconcile-list-flags-tenant-a");
    const tenantB = await createRestaurant("reconcile-list-flags-tenant-b");
    const branchA = await createBranch(tenantA.restaurantId);
    const deviceA = await createDevice(tenantA, branchA);
    const { orderId } = await createClosedOrderWithItems(tenantA, branchA, [10_000n]);
    const invoice = await invoicesService.generate({ restaurantId: tenantA.restaurantId, orderId, deviceId: deviceA, actorUserId: tenantA.ownerUserId });
    const { productId, priceListId } = await createPricedProduct(tenantA.restaurantId, tenantA.ownerUserId, 1_000n);
    await withTenant(db, { restaurantId: tenantA.restaurantId }, (tx) =>
      tx.insert(schema.orderItems).values({
        restaurantId: tenantA.restaurantId,
        orderId,
        productId,
        quantity: 1,
        unitPriceMinor: 1_000n,
        currency: "PKR",
        priceListId,
        priceListVersion: 1,
        invoiceId: invoice.id,
      }),
    );
    await service.reconcileInvoice({ restaurantId: tenantA.restaurantId, invoiceId: invoice.id });

    const tenantBFlags = await service.listFlags({ restaurantId: tenantB.restaurantId });
    expect(tenantBFlags.map((flag) => flag.invoiceId)).not.toContain(invoice.id);
  });
});
