import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { CategoriesService } from "./categories.service.js";
import { DeviceService } from "./device.service.js";
import { InvoicesService } from "./invoices.service.js";
import { OrderItemsService } from "./order-items.service.js";
import { OrdersService } from "./orders.service.js";
import { PaymentMethodSettingsService } from "./payment-method-settings.service.js";
import { PaymentsService } from "./payments.service.js";
import { PriceListItemsService } from "./price-list-items.service.js";
import { PriceListsService } from "./price-lists.service.js";
import { PriceResolutionService } from "./price-resolution.service.js";
import { ProductsService } from "./products.service.js";
import { ServiceChargeSettingsService } from "./service-charge-settings.service.js";
import { TaxCalculationService } from "./tax-calculation.service.js";
import { TaxRulesService } from "./tax-rules.service.js";
import { TaxSettingsService } from "./tax-settings.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: PaymentsService;
let paymentMethodSettingsService: PaymentMethodSettingsService;
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
  paymentMethodSettingsService = new PaymentMethodSettingsService(db, auditLogService);
  service = new PaymentsService(db, auditLogService, paymentMethodSettingsService);
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

async function createPricedProduct(restaurantId: string, actorUserId: string, unitPriceMinor: bigint): Promise<string> {
  const category = await categoriesService.create({ restaurantId, actorUserId, name: "Burgers" });
  const product = await productsService.create({ restaurantId, actorUserId, categoryId: category.id, name: "Cheeseburger" });
  const priceList = await priceListsService.create({ restaurantId, actorUserId, name: `List-${randomUUID()}`, currency: "PKR" });
  await priceListItemsService.setPrice({ restaurantId, actorUserId, priceListId: priceList.id, productId: product.id, unitPriceMinor });
  await priceListsService.publish({ restaurantId, actorUserId, priceListId: priceList.id });
  return product.id;
}

/** A generated invoice (10000 minor units, no tax configured) — the common starting point for payment tests. */
async function createInvoice(tenant: { restaurantId: string; ownerUserId: string }, branchId: string): Promise<string> {
  const productId = await createPricedProduct(tenant.restaurantId, tenant.ownerUserId, 10_000n);
  const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
  const order = await ordersService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "takeaway", currency: "PKR" });
  await orderItemsService.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId: order.id, productId });
  await ordersService.close({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId });
  const invoice = await invoicesService.generate({ restaurantId: tenant.restaurantId, orderId: order.id, deviceId: device.id, actorUserId: tenant.ownerUserId });
  return invoice.id;
}

describe("PaymentsService.record", () => {
  it("records a cash payment with a tip", async () => {
    const tenant = await createRestaurant("payment-happy-path");
    const branchId = await createBranch(tenant.restaurantId);
    const invoiceId = await createInvoice(tenant, branchId);

    const payment = await service.record({ restaurantId: tenant.restaurantId, invoiceId, actorUserId: tenant.ownerUserId, method: "cash", amountMinor: 10_000n, tipMinor: 500n });

    expect(payment.method).toBe("cash");
    expect(payment.amountMinor).toBe(10_000n);
    expect(payment.tipMinor).toBe(500n);
    expect(payment.currency).toBe("PKR");

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "payment.recorded" && row.targetId === payment.id)).toBe(true);
  });

  it("defaults the tip to zero when not given", async () => {
    const tenant = await createRestaurant("payment-no-tip");
    const branchId = await createBranch(tenant.restaurantId);
    const invoiceId = await createInvoice(tenant, branchId);

    const payment = await service.record({ restaurantId: tenant.restaurantId, invoiceId, actorUserId: tenant.ownerUserId, method: "card", amountMinor: 10_000n });
    expect(payment.tipMinor).toBe(0n);
  });

  it("allows more than one payment against the same invoice", async () => {
    const tenant = await createRestaurant("payment-multiple");
    const branchId = await createBranch(tenant.restaurantId);
    const invoiceId = await createInvoice(tenant, branchId);

    await service.record({ restaurantId: tenant.restaurantId, invoiceId, actorUserId: tenant.ownerUserId, method: "cash", amountMinor: 4_000n });
    await service.record({ restaurantId: tenant.restaurantId, invoiceId, actorUserId: tenant.ownerUserId, method: "card", amountMinor: 6_000n });

    const payments = await service.listForInvoice({ restaurantId: tenant.restaurantId, invoiceId });
    expect(payments).toHaveLength(2);
    expect(payments.map((p) => p.method).sort()).toEqual(["card", "cash"]);
  });

  it("rejects a zero or negative amount", async () => {
    const tenant = await createRestaurant("payment-bad-amount");
    const branchId = await createBranch(tenant.restaurantId);
    const invoiceId = await createInvoice(tenant, branchId);

    await expect(
      service.record({ restaurantId: tenant.restaurantId, invoiceId, actorUserId: tenant.ownerUserId, method: "cash", amountMinor: 0n }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.record({ restaurantId: tenant.restaurantId, invoiceId, actorUserId: tenant.ownerUserId, method: "cash", amountMinor: -100n }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a negative tip", async () => {
    const tenant = await createRestaurant("payment-bad-tip");
    const branchId = await createBranch(tenant.restaurantId);
    const invoiceId = await createInvoice(tenant, branchId);

    await expect(
      service.record({ restaurantId: tenant.restaurantId, invoiceId, actorUserId: tenant.ownerUserId, method: "cash", amountMinor: 10_000n, tipMinor: -1n }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a disabled payment method", async () => {
    const tenant = await createRestaurant("payment-disabled-method");
    const branchId = await createBranch(tenant.restaurantId);
    const invoiceId = await createInvoice(tenant, branchId);
    await paymentMethodSettingsService.set({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, method: "wallet", enabled: false });

    await expect(
      service.record({ restaurantId: tenant.restaurantId, invoiceId, actorUserId: tenant.ownerUserId, method: "wallet", amountMinor: 10_000n }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects an invoice that doesn't exist, including one from a different tenant", async () => {
    const tenantA = await createRestaurant("payment-cross-tenant-a");
    const tenantB = await createRestaurant("payment-cross-tenant-b");
    const branchA = await createBranch(tenantA.restaurantId);
    const invoiceId = await createInvoice(tenantA, branchA);

    await expect(
      service.record({ restaurantId: tenantB.restaurantId, invoiceId, actorUserId: tenantB.ownerUserId, method: "cash", amountMinor: 10_000n }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      service.record({ restaurantId: tenantA.restaurantId, invoiceId: randomUUID(), actorUserId: tenantA.ownerUserId, method: "cash", amountMinor: 10_000n }),
    ).rejects.toThrow(NotFoundException);
  });

  it("P2-20: computes exact change for a cash payment tendered above the remaining balance", async () => {
    const tenant = await createRestaurant("payment-exact-change");
    const branchId = await createBranch(tenant.restaurantId);
    const invoiceId = await createInvoice(tenant, branchId);

    const payment = await service.record({
      restaurantId: tenant.restaurantId,
      invoiceId,
      actorUserId: tenant.ownerUserId,
      method: "cash",
      amountMinor: 10_000n,
      tenderedMinor: 10_500n,
    });

    expect(payment.amountMinor).toBe(10_000n);
    expect(payment.changeMinor).toBe(500n);
  });

  it("P2-20: tenderedMinor is rejected for any method other than cash", async () => {
    const tenant = await createRestaurant("payment-tendered-non-cash");
    const branchId = await createBranch(tenant.restaurantId);
    const invoiceId = await createInvoice(tenant, branchId);

    await expect(
      service.record({ restaurantId: tenant.restaurantId, invoiceId, actorUserId: tenant.ownerUserId, method: "card", amountMinor: 10_000n, tenderedMinor: 11_000n }),
    ).rejects.toThrow(BadRequestException);
  });

  it("P2-20: tenderedMinor cannot be less than amountMinor", async () => {
    const tenant = await createRestaurant("payment-tendered-too-little");
    const branchId = await createBranch(tenant.restaurantId);
    const invoiceId = await createInvoice(tenant, branchId);

    await expect(
      service.record({ restaurantId: tenant.restaurantId, invoiceId, actorUserId: tenant.ownerUserId, method: "cash", amountMinor: 10_000n, tenderedMinor: 9_000n }),
    ).rejects.toThrow(BadRequestException);
  });

  it("P2-20: a split payment across three methods exactly settles the invoice", async () => {
    const tenant = await createRestaurant("payment-three-way-split");
    const branchId = await createBranch(tenant.restaurantId);
    const invoiceId = await createInvoice(tenant, branchId);

    await service.record({ restaurantId: tenant.restaurantId, invoiceId, actorUserId: tenant.ownerUserId, method: "cash", amountMinor: 3_000n });
    await service.record({ restaurantId: tenant.restaurantId, invoiceId, actorUserId: tenant.ownerUserId, method: "card", amountMinor: 3_000n });
    await service.record({ restaurantId: tenant.restaurantId, invoiceId, actorUserId: tenant.ownerUserId, method: "wallet", amountMinor: 4_000n });

    const balance = await service.getBalance({ restaurantId: tenant.restaurantId, invoiceId });
    expect(balance.remainingMinor).toBe(0n);
    expect(balance.paidMinor).toBe(10_000n);
  });

  it("P2-20: rejects a payment that would push the total past the invoice's own total", async () => {
    const tenant = await createRestaurant("payment-overpay");
    const branchId = await createBranch(tenant.restaurantId);
    const invoiceId = await createInvoice(tenant, branchId);

    await service.record({ restaurantId: tenant.restaurantId, invoiceId, actorUserId: tenant.ownerUserId, method: "cash", amountMinor: 6_000n });

    await expect(
      service.record({ restaurantId: tenant.restaurantId, invoiceId, actorUserId: tenant.ownerUserId, method: "card", amountMinor: 5_000n }),
    ).rejects.toThrow(BadRequestException);
  });

  it("P2-20: rejects any further payment once the invoice is already paid in full", async () => {
    const tenant = await createRestaurant("payment-already-paid");
    const branchId = await createBranch(tenant.restaurantId);
    const invoiceId = await createInvoice(tenant, branchId);

    await service.record({ restaurantId: tenant.restaurantId, invoiceId, actorUserId: tenant.ownerUserId, method: "cash", amountMinor: 10_000n });

    await expect(
      service.record({ restaurantId: tenant.restaurantId, invoiceId, actorUserId: tenant.ownerUserId, method: "card", amountMinor: 1n }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe("PaymentsService.listForInvoice", () => {
  it("returns an empty list before any payment has been recorded", async () => {
    const tenant = await createRestaurant("payment-empty-list");
    const branchId = await createBranch(tenant.restaurantId);
    const invoiceId = await createInvoice(tenant, branchId);

    expect(await service.listForInvoice({ restaurantId: tenant.restaurantId, invoiceId })).toEqual([]);
  });
});

describe("PaymentsService.getBalance", () => {
  it("starts at the full invoice total with nothing paid", async () => {
    const tenant = await createRestaurant("payment-balance-initial");
    const branchId = await createBranch(tenant.restaurantId);
    const invoiceId = await createInvoice(tenant, branchId);

    const balance = await service.getBalance({ restaurantId: tenant.restaurantId, invoiceId });
    expect(balance).toEqual({ totalMinor: 10_000n, paidMinor: 0n, remainingMinor: 10_000n });
  });

  it("reflects a partial payment", async () => {
    const tenant = await createRestaurant("payment-balance-partial");
    const branchId = await createBranch(tenant.restaurantId);
    const invoiceId = await createInvoice(tenant, branchId);

    await service.record({ restaurantId: tenant.restaurantId, invoiceId, actorUserId: tenant.ownerUserId, method: "cash", amountMinor: 4_000n });

    const balance = await service.getBalance({ restaurantId: tenant.restaurantId, invoiceId });
    expect(balance).toEqual({ totalMinor: 10_000n, paidMinor: 4_000n, remainingMinor: 6_000n });
  });

  it("rejects an invoice that doesn't exist", async () => {
    const tenant = await createRestaurant("payment-balance-not-found");
    await expect(service.getBalance({ restaurantId: tenant.restaurantId, invoiceId: randomUUID() })).rejects.toThrow(NotFoundException);
  });
});

describe("PaymentsService.suggestEqualSplit", () => {
  it("splits the full balance into equal parts that sum back to it exactly, even when it doesn't divide evenly", async () => {
    const tenant = await createRestaurant("payment-split-equal");
    const branchId = await createBranch(tenant.restaurantId);
    const invoiceId = await createInvoice(tenant, branchId); // total = 10_000

    const shares = await service.suggestEqualSplit({ restaurantId: tenant.restaurantId, invoiceId, parts: 3 });

    expect(shares).toHaveLength(3);
    expect(shares.reduce((total, share) => total + share.amountMinor, 0n)).toBe(10_000n);
    // largest-remainder distribution: 3334 + 3333 + 3333
    expect(shares.map((s) => s.amountMinor).sort((a, b) => Number(b - a))).toEqual([3_334n, 3_333n, 3_333n]);
  });

  it("splits only the remaining balance, after a partial payment", async () => {
    const tenant = await createRestaurant("payment-split-equal-partial");
    const branchId = await createBranch(tenant.restaurantId);
    const invoiceId = await createInvoice(tenant, branchId);
    await service.record({ restaurantId: tenant.restaurantId, invoiceId, actorUserId: tenant.ownerUserId, method: "cash", amountMinor: 4_000n });

    const shares = await service.suggestEqualSplit({ restaurantId: tenant.restaurantId, invoiceId, parts: 2 });
    expect(shares.reduce((total, share) => total + share.amountMinor, 0n)).toBe(6_000n);
  });

  it("rejects a non-positive parts count", async () => {
    const tenant = await createRestaurant("payment-split-equal-bad-parts");
    const branchId = await createBranch(tenant.restaurantId);
    const invoiceId = await createInvoice(tenant, branchId);

    await expect(service.suggestEqualSplit({ restaurantId: tenant.restaurantId, invoiceId, parts: 0 })).rejects.toThrow(BadRequestException);
  });

  it("rejects an invoice that doesn't exist", async () => {
    const tenant = await createRestaurant("payment-split-equal-not-found");
    await expect(service.suggestEqualSplit({ restaurantId: tenant.restaurantId, invoiceId: randomUUID(), parts: 2 })).rejects.toThrow(NotFoundException);
  });
});
