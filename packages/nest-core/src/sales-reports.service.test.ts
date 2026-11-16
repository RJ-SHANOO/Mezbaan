import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { SalesReportsService } from "./sales-reports.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: SalesReportsService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  service = new SalesReportsService(db);
});

afterAll(async () => {
  await pool.end();
});

interface Tenant {
  restaurantId: string;
  branchId: string;
  ownerUserId: string;
  productId: string;
  priceListId: string;
}

/** Fixed, non-UTC-aligned timezone so "business date" tests actually
 * exercise the local-time conversion rather than coincidentally matching
 * server UTC. */
const TEST_TIMEZONE = "Asia/Karachi"; // UTC+5, no DST

async function createTenant(label: string, timezone: string = TEST_TIMEZONE): Promise<Tenant> {
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
    const branchRows = await tx.insert(schema.branches).values({ restaurantId: restaurant.id, name: "Main", timezone }).returning({ id: schema.branches.id });
    const branch = branchRows[0];
    if (!branch) throw new Error("fixture: branch insert returned no row");

    const ownerRows = await tx
      .insert(schema.users)
      .values({ restaurantId: restaurant.id, roleId: role.id, email: `${label}@example.test`, passwordHash: "unused", displayName: label })
      .returning({ id: schema.users.id });
    const owner = ownerRows[0];
    if (!owner) throw new Error("fixture: user insert returned no row");

    const categoryRows = await tx.insert(schema.categories).values({ restaurantId: restaurant.id, name: "Mains" }).returning({ id: schema.categories.id });
    const category = categoryRows[0];
    if (!category) throw new Error("fixture: category insert returned no row");

    const productRows = await tx.insert(schema.products).values({ restaurantId: restaurant.id, categoryId: category.id, name: "Burger" }).returning({ id: schema.products.id });
    const product = productRows[0];
    if (!product) throw new Error("fixture: product insert returned no row");

    const priceListRows = await tx.insert(schema.priceLists).values({ restaurantId: restaurant.id, name: "Default", version: 1, currency: "PKR" }).returning({ id: schema.priceLists.id });
    const priceList = priceListRows[0];
    if (!priceList) throw new Error("fixture: price list insert returned no row");

    return { restaurantId: restaurant.id, branchId: branch.id, ownerUserId: owner.id, productId: product.id, priceListId: priceList.id };
  });
}

async function createOrder(tenant: Tenant): Promise<string> {
  return withTenant(db, { restaurantId: tenant.restaurantId }, async (tx) => {
    const rows = await tx
      .insert(schema.orders)
      .values({ restaurantId: tenant.restaurantId, branchId: tenant.branchId, orderType: "takeaway", currency: "PKR", openedByUserId: tenant.ownerUserId })
      .returning({ id: schema.orders.id });
    return rows[0]!.id;
  });
}

async function createDevice(tenant: Tenant): Promise<string> {
  return withTenant(db, { restaurantId: tenant.restaurantId }, async (tx) => {
    const rows = await tx.insert(schema.devices).values({ restaurantId: tenant.restaurantId, branchId: tenant.branchId, label: "Till 1", deviceType: "pos_terminal" }).returning({ id: schema.devices.id });
    return rows[0]!.id;
  });
}

/** Inserts an invoice directly at a given UTC instant — bypasses
 * InvoicesService entirely since this test is only exercising
 * SalesReportsService's own aggregation over already-stored rows, not
 * invoice generation itself (already tested elsewhere). */
async function createInvoiceAt(tenant: Tenant, orderId: string, deviceId: string, createdAt: Date, totals: { subtotalMinor: bigint; taxMinor: bigint; serviceChargeMinor: bigint; totalMinor: bigint }): Promise<string> {
  return withTenant(db, { restaurantId: tenant.restaurantId }, async (tx) => {
    const rows = await tx
      .insert(schema.invoices)
      .values({
        restaurantId: tenant.restaurantId,
        branchId: tenant.branchId,
        orderId,
        deviceId,
        documentNumber: `TEST-${randomUUID()}`,
        subtotalMinor: totals.subtotalMinor,
        serviceChargeMinor: totals.serviceChargeMinor,
        taxMinor: totals.taxMinor,
        totalMinor: totals.totalMinor,
        currency: "PKR",
        pricingMode: "exclusive",
        taxRateBasisPoints: 1000,
        appliedTaxRules: [],
        actorUserId: tenant.ownerUserId,
        createdAt,
      })
      .returning({ id: schema.invoices.id });
    return rows[0]!.id;
  });
}

async function createPaymentAt(tenant: Tenant, invoiceId: string, method: "cash" | "card" | "bank_transfer" | "wallet", amountMinor: bigint, tipMinor: bigint, createdAt: Date): Promise<void> {
  await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) =>
    tx.insert(schema.payments).values({ restaurantId: tenant.restaurantId, branchId: tenant.branchId, invoiceId, method, amountMinor, tipMinor, currency: "PKR", actorUserId: tenant.ownerUserId, createdAt }),
  );
}

async function createRefundAt(tenant: Tenant, invoiceId: string, amountMinor: bigint, reasonCode: string, createdAt: Date): Promise<void> {
  await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) =>
    tx.insert(schema.refunds).values({ restaurantId: tenant.restaurantId, branchId: tenant.branchId, invoiceId, amountMinor, currency: "PKR", reasonCode, actorUserId: tenant.ownerUserId, approvedByUserId: tenant.ownerUserId, createdAt }),
  );
}

interface ItemOverrides {
  voidedAt?: Date;
  voidReasonCode?: string;
  discountPercentBasisPoints?: number;
  discountAmountMinor?: bigint;
  discountReasonCode?: string;
  updatedAt?: Date;
}

async function createOrderItem(tenant: Tenant, orderId: string, unitPriceMinor: bigint, quantity: number, overrides: ItemOverrides = {}): Promise<string> {
  return withTenant(db, { restaurantId: tenant.restaurantId }, async (tx) => {
    const rows = await tx
      .insert(schema.orderItems)
      .values({
        restaurantId: tenant.restaurantId,
        orderId,
        productId: tenant.productId,
        quantity,
        unitPriceMinor,
        currency: "PKR",
        priceListId: tenant.priceListId,
        priceListVersion: 1,
        voidedAt: overrides.voidedAt ?? null,
        voidedByUserId: overrides.voidedAt ? tenant.ownerUserId : null,
        voidReasonCode: overrides.voidReasonCode ?? null,
        discountPercentBasisPoints: overrides.discountPercentBasisPoints ?? null,
        discountAmountMinor: overrides.discountAmountMinor ?? null,
        discountReasonCode: overrides.discountReasonCode ?? null,
        discountApprovedByUserId: overrides.discountPercentBasisPoints !== undefined || overrides.discountAmountMinor !== undefined ? tenant.ownerUserId : null,
        updatedAt: overrides.updatedAt,
      })
      .returning({ id: schema.orderItems.id });
    return rows[0]!.id;
  });
}

/** Midday on `businessDate` in TEST_TIMEZONE (UTC+5) is safely inside that
 * business day's UTC window regardless of exactly where midnight falls. */
function middayUtc(businessDate: string): Date {
  return new Date(`${businessDate}T07:00:00Z`); // 12:00 PKT
}

describe("SalesReportsService.getDailySummary", () => {
  it("sums invoices created within the business day and excludes ones outside it", async () => {
    const tenant = await createTenant("report-summary-ok");
    const orderId = await createOrder(tenant);
    const deviceId = await createDevice(tenant);

    await createInvoiceAt(tenant, orderId, deviceId, middayUtc("2026-03-10"), { subtotalMinor: 10_000n, taxMinor: 1_000n, serviceChargeMinor: 500n, totalMinor: 11_500n });
    await createInvoiceAt(tenant, orderId, deviceId, middayUtc("2026-03-10"), { subtotalMinor: 5_000n, taxMinor: 500n, serviceChargeMinor: 0n, totalMinor: 5_500n });
    await createInvoiceAt(tenant, orderId, deviceId, middayUtc("2026-03-11"), { subtotalMinor: 99_999n, taxMinor: 0n, serviceChargeMinor: 0n, totalMinor: 99_999n }); // a different day — excluded

    const summary = await service.getDailySummary({ restaurantId: tenant.restaurantId, branchId: tenant.branchId, businessDate: "2026-03-10" });

    expect(summary.orderCount).toBe(2);
    expect(summary.subtotalMinor).toBe(15_000n);
    expect(summary.taxMinor).toBe(1_500n);
    expect(summary.serviceChargeMinor).toBe(500n);
    expect(summary.grossSalesMinor).toBe(17_000n);
  });

  it("an invoice right at the branch's local midnight boundary lands in the correct business day", async () => {
    const tenant = await createTenant("report-summary-boundary");
    const orderId = await createOrder(tenant);
    const deviceId = await createDevice(tenant);

    // 2026-03-10T00:00:00 in Asia/Karachi (UTC+5) is 2026-03-09T19:00:00Z.
    await createInvoiceAt(tenant, orderId, deviceId, new Date("2026-03-09T19:00:00.000Z"), { subtotalMinor: 1_000n, taxMinor: 0n, serviceChargeMinor: 0n, totalMinor: 1_000n });
    // One millisecond earlier belongs to the PREVIOUS business day.
    await createInvoiceAt(tenant, orderId, deviceId, new Date("2026-03-09T18:59:59.999Z"), { subtotalMinor: 2_000n, taxMinor: 0n, serviceChargeMinor: 0n, totalMinor: 2_000n });

    const mar10 = await service.getDailySummary({ restaurantId: tenant.restaurantId, branchId: tenant.branchId, businessDate: "2026-03-10" });
    const mar9 = await service.getDailySummary({ restaurantId: tenant.restaurantId, branchId: tenant.branchId, businessDate: "2026-03-09" });

    expect(mar10.grossSalesMinor).toBe(1_000n);
    expect(mar9.grossSalesMinor).toBe(2_000n);
  });

  it("a day with no invoices at all returns zeros, not an error", async () => {
    const tenant = await createTenant("report-summary-empty");
    const summary = await service.getDailySummary({ restaurantId: tenant.restaurantId, branchId: tenant.branchId, businessDate: "2026-01-01" });
    expect(summary).toMatchObject({ orderCount: 0, subtotalMinor: 0n, taxMinor: 0n, serviceChargeMinor: 0n, grossSalesMinor: 0n });
  });
});

describe("SalesReportsService.getPaymentBreakdown", () => {
  it("sums by method and tips, within the business day", async () => {
    const tenant = await createTenant("report-payments-ok");
    const orderId = await createOrder(tenant);
    const deviceId = await createDevice(tenant);
    const invoiceId = await createInvoiceAt(tenant, orderId, deviceId, middayUtc("2026-03-10"), { subtotalMinor: 10_000n, taxMinor: 0n, serviceChargeMinor: 0n, totalMinor: 10_000n });

    await createPaymentAt(tenant, invoiceId, "cash", 6_000n, 200n, middayUtc("2026-03-10"));
    await createPaymentAt(tenant, invoiceId, "card", 4_000n, 0n, middayUtc("2026-03-10"));
    await createPaymentAt(tenant, invoiceId, "cash", 999_999n, 0n, middayUtc("2026-03-11")); // different day — excluded

    const breakdown = await service.getPaymentBreakdown({ restaurantId: tenant.restaurantId, branchId: tenant.branchId, businessDate: "2026-03-10" });

    expect(breakdown.byMethod.cash).toBe(6_000n);
    expect(breakdown.byMethod.card).toBe(4_000n);
    expect(breakdown.byMethod.bank_transfer).toBe(0n);
    expect(breakdown.tipsMinor).toBe(200n);
    expect(breakdown.totalMinor).toBe(10_000n);
  });
});

describe("SalesReportsService.getVoidReport", () => {
  it("reports the pre-discount line value of voided items and tallies reason codes", async () => {
    const tenant = await createTenant("report-voids-ok");
    const orderId = await createOrder(tenant);

    await createOrderItem(tenant, orderId, 1_000n, 2, { voidedAt: middayUtc("2026-03-10"), voidReasonCode: "mistake" }); // 2,000
    await createOrderItem(tenant, orderId, 500n, 1, { voidedAt: middayUtc("2026-03-10"), voidReasonCode: "mistake" }); // 500
    await createOrderItem(tenant, orderId, 300n, 1, { voidedAt: middayUtc("2026-03-10"), voidReasonCode: "kitchen_error" }); // 300
    await createOrderItem(tenant, orderId, 777n, 1); // not voided — excluded
    await createOrderItem(tenant, orderId, 888n, 1, { voidedAt: middayUtc("2026-03-11"), voidReasonCode: "mistake" }); // different day — excluded

    const report = await service.getVoidReport({ restaurantId: tenant.restaurantId, branchId: tenant.branchId, businessDate: "2026-03-10" });

    expect(report.entries).toHaveLength(3);
    expect(report.totalValueMinor).toBe(2_800n);
    expect(report.countByReasonCode).toEqual({ mistake: 2, kitchen_error: 1 });
  });
});

describe("SalesReportsService.getDiscountReport", () => {
  it("computes each item's own discount amount via domain math, item-level only", async () => {
    const tenant = await createTenant("report-discounts-ok");
    const orderId = await createOrder(tenant);
    const now = middayUtc("2026-03-10");

    // 10,000 at 10% = 1,000 discount.
    await createOrderItem(tenant, orderId, 10_000n, 1, { discountPercentBasisPoints: 1000, discountReasonCode: "loyalty", updatedAt: now });
    // Fixed 500 discount on a 2,000 line.
    await createOrderItem(tenant, orderId, 1_000n, 2, { discountAmountMinor: 500n, discountReasonCode: "comp", updatedAt: now });
    await createOrderItem(tenant, orderId, 777n, 1, { updatedAt: now }); // no discount — excluded
    await createOrderItem(tenant, orderId, 999n, 1, { discountPercentBasisPoints: 1000, discountReasonCode: "loyalty", updatedAt: middayUtc("2026-03-11") }); // different day — excluded

    const report = await service.getDiscountReport({ restaurantId: tenant.restaurantId, branchId: tenant.branchId, businessDate: "2026-03-10" });

    expect(report.entries).toHaveLength(2);
    expect(report.totalDiscountMinor).toBe(1_500n);
    expect(report.countByReasonCode).toEqual({ loyalty: 1, comp: 1 });
  });

  it("a voided item's discount is not double-counted in the report", async () => {
    const tenant = await createTenant("report-discounts-voided-excluded");
    const orderId = await createOrder(tenant);
    const now = middayUtc("2026-03-10");

    await createOrderItem(tenant, orderId, 10_000n, 1, { discountPercentBasisPoints: 1000, discountReasonCode: "loyalty", voidedAt: now, voidReasonCode: "mistake", updatedAt: now });

    const report = await service.getDiscountReport({ restaurantId: tenant.restaurantId, branchId: tenant.branchId, businessDate: "2026-03-10" });
    expect(report.entries).toHaveLength(0);
  });
});

describe("SalesReportsService.getRefundReport", () => {
  it("sums refunds and tallies reason codes within the business day", async () => {
    const tenant = await createTenant("report-refunds-ok");
    const orderId = await createOrder(tenant);
    const deviceId = await createDevice(tenant);
    const invoiceId = await createInvoiceAt(tenant, orderId, deviceId, middayUtc("2026-03-10"), { subtotalMinor: 10_000n, taxMinor: 0n, serviceChargeMinor: 0n, totalMinor: 10_000n });

    await createRefundAt(tenant, invoiceId, 3_000n, "complaint", middayUtc("2026-03-10"));
    await createRefundAt(tenant, invoiceId, 1_000n, "complaint", middayUtc("2026-03-10"));
    await createRefundAt(tenant, invoiceId, 999n, "mistake", middayUtc("2026-03-11")); // different day — excluded

    const report = await service.getRefundReport({ restaurantId: tenant.restaurantId, branchId: tenant.branchId, businessDate: "2026-03-10" });

    expect(report.entries).toHaveLength(2);
    expect(report.totalRefundedMinor).toBe(4_000n);
    expect(report.countByReasonCode).toEqual({ complaint: 2 });
  });
});
