import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
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
import { ServiceChargeSettingsService } from "./service-charge-settings.service.js";
import { TaxCalculationService } from "./tax-calculation.service.js";
import { TaxRulesService } from "./tax-rules.service.js";
import { TaxSettingsService } from "./tax-settings.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: InvoicesService;
let ordersService: OrdersService;
let orderItemsService: OrderItemsService;
let deviceService: DeviceService;
let categoriesService: CategoriesService;
let productsService: ProductsService;
let priceListsService: PriceListsService;
let priceListItemsService: PriceListItemsService;
let taxRulesService: TaxRulesService;

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
  taxRulesService = new TaxRulesService(db, auditLogService);
  const taxSettingsService = new TaxSettingsService(db, auditLogService);
  const serviceChargeSettingsService = new ServiceChargeSettingsService(db, auditLogService);
  const taxCalculationService = new TaxCalculationService(taxRulesService, taxSettingsService, serviceChargeSettingsService);
  service = new InvoicesService(db, auditLogService, taxCalculationService);
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

/** A closed takeaway order with one priced item — the common starting point for invoice generation. */
async function createClosedOrderWithItem(tenant: { restaurantId: string; ownerUserId: string }, branchId: string): Promise<string> {
  const productId = await createPricedProduct(tenant.restaurantId, tenant.ownerUserId, 10_000n);
  const order = await ordersService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "takeaway", currency: "PKR" });
  await orderItemsService.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId: order.id, productId });
  await ordersService.close({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId });
  return order.id;
}

describe("InvoicesService.generate", () => {
  it("generates an invoice with a per-terminal document number and domain-computed totals", async () => {
    const tenant = await createRestaurant("invoice-happy-path");
    const branchId = await createBranch(tenant.restaurantId);
    await taxRulesService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "GST", rateBasisPoints: 1000 });
    const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
    const orderId = await createClosedOrderWithItem(tenant, branchId);

    const invoice = await service.generate({ restaurantId: tenant.restaurantId, orderId, deviceId: device.id, actorUserId: tenant.ownerUserId });

    expect(invoice.documentNumber).toMatch(/^B\d+-T\d+-\d{6}$/);
    expect(invoice.subtotalMinor).toBe(10_000n);
    expect(invoice.taxMinor).toBe(1_000n);
    expect(invoice.serviceChargeMinor).toBe(0n);
    expect(invoice.totalMinor).toBe(11_000n);
    expect(invoice.appliedTaxRules).toEqual([{ name: "GST", rateBasisPoints: 1000 }]);

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "invoice.generated" && row.targetId === invoice.id)).toBe(true);
  });

  it("rejects generating an invoice for an order that isn't closed yet", async () => {
    const tenant = await createRestaurant("invoice-not-closed");
    const branchId = await createBranch(tenant.restaurantId);
    const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
    const productId = await createPricedProduct(tenant.restaurantId, tenant.ownerUserId, 10_000n);
    const order = await ordersService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "takeaway", currency: "PKR" });
    await orderItemsService.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId: order.id, productId });

    await expect(
      service.generate({ restaurantId: tenant.restaurantId, orderId: order.id, deviceId: device.id, actorUserId: tenant.ownerUserId }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a second invoice for the same order", async () => {
    const tenant = await createRestaurant("invoice-no-regenerate");
    const branchId = await createBranch(tenant.restaurantId);
    const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
    const orderId = await createClosedOrderWithItem(tenant, branchId);

    await service.generate({ restaurantId: tenant.restaurantId, orderId, deviceId: device.id, actorUserId: tenant.ownerUserId });

    await expect(
      service.generate({ restaurantId: tenant.restaurantId, orderId, deviceId: device.id, actorUserId: tenant.ownerUserId }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects an order with no items", async () => {
    const tenant = await createRestaurant("invoice-no-items");
    const branchId = await createBranch(tenant.restaurantId);
    const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
    const order = await ordersService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "takeaway", currency: "PKR" });
    await ordersService.close({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId });

    await expect(
      service.generate({ restaurantId: tenant.restaurantId, orderId: order.id, deviceId: device.id, actorUserId: tenant.ownerUserId }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a device that belongs to a different branch", async () => {
    const tenant = await createRestaurant("invoice-wrong-branch");
    const branchA = await createBranch(tenant.restaurantId);
    const branchB = await createBranch(tenant.restaurantId);
    const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId: branchB, label: "Till 1", deviceType: "pos_terminal" });
    const orderId = await createClosedOrderWithItem(tenant, branchA);

    await expect(
      service.generate({ restaurantId: tenant.restaurantId, orderId, deviceId: device.id, actorUserId: tenant.ownerUserId }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a revoked device", async () => {
    const tenant = await createRestaurant("invoice-revoked-device");
    const branchId = await createBranch(tenant.restaurantId);
    const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
    await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) =>
      tx.update(schema.devices).set({ status: "revoked" }).where(eq(schema.devices.id, device.id)),
    );
    const orderId = await createClosedOrderWithItem(tenant, branchId);

    await expect(
      service.generate({ restaurantId: tenant.restaurantId, orderId, deviceId: device.id, actorUserId: tenant.ownerUserId }),
    ).rejects.toThrow(BadRequestException);
  });

  it("gives each device its own independent, incrementing sequence", async () => {
    const tenant = await createRestaurant("invoice-per-device-sequence");
    const branchId = await createBranch(tenant.restaurantId);
    const deviceA = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till A", deviceType: "pos_terminal" });
    const deviceB = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till B", deviceType: "pos_terminal" });

    const orderA1 = await createClosedOrderWithItem(tenant, branchId);
    const orderA2 = await createClosedOrderWithItem(tenant, branchId);
    const orderB1 = await createClosedOrderWithItem(tenant, branchId);

    const invoiceA1 = await service.generate({ restaurantId: tenant.restaurantId, orderId: orderA1, deviceId: deviceA.id, actorUserId: tenant.ownerUserId });
    const invoiceA2 = await service.generate({ restaurantId: tenant.restaurantId, orderId: orderA2, deviceId: deviceA.id, actorUserId: tenant.ownerUserId });
    const invoiceB1 = await service.generate({ restaurantId: tenant.restaurantId, orderId: orderB1, deviceId: deviceB.id, actorUserId: tenant.ownerUserId });

    expect(invoiceA1.documentNumber.endsWith("000001")).toBe(true);
    expect(invoiceA2.documentNumber.endsWith("000002")).toBe(true);
    expect(invoiceB1.documentNumber.endsWith("000001")).toBe(true);
  });

  it("rejects an order or device from a different tenant", async () => {
    const tenantA = await createRestaurant("invoice-cross-tenant-a");
    const tenantB = await createRestaurant("invoice-cross-tenant-b");
    const branchA = await createBranch(tenantA.restaurantId);
    const branchB = await createBranch(tenantB.restaurantId);
    const deviceA = await deviceService.create({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, branchId: branchA, label: "Till 1", deviceType: "pos_terminal" });
    const deviceB = await deviceService.create({ restaurantId: tenantB.restaurantId, actorUserId: tenantB.ownerUserId, branchId: branchB, label: "Till 1", deviceType: "pos_terminal" });
    const orderA = await createClosedOrderWithItem(tenantA, branchA);

    await expect(
      service.generate({ restaurantId: tenantB.restaurantId, orderId: orderA, deviceId: deviceB.id, actorUserId: tenantB.ownerUserId }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      service.generate({ restaurantId: tenantA.restaurantId, orderId: orderA, deviceId: deviceA.id, actorUserId: tenantA.ownerUserId }),
    ).resolves.toBeDefined();
  });
});

describe("InvoicesService.getByOrderId", () => {
  it("returns null before an invoice exists, and the invoice once generated", async () => {
    const tenant = await createRestaurant("invoice-get-by-order");
    const branchId = await createBranch(tenant.restaurantId);
    const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
    const orderId = await createClosedOrderWithItem(tenant, branchId);

    expect(await service.getByOrderId({ restaurantId: tenant.restaurantId, orderId })).toBeNull();

    const invoice = await service.generate({ restaurantId: tenant.restaurantId, orderId, deviceId: device.id, actorUserId: tenant.ownerUserId });

    expect(await service.getByOrderId({ restaurantId: tenant.restaurantId, orderId })).toEqual(invoice);
  });
});

/** P2-21: a closed dine-in-shaped (but takeaway, no table needed) order with
 * one item per given seat number — the common starting point for split tests. */
async function createClosedOrderWithSeats(tenant: { restaurantId: string; ownerUserId: string }, branchId: string, seats: Array<number | undefined>): Promise<{ orderId: string; itemIds: string[] }> {
  const productId = await createPricedProduct(tenant.restaurantId, tenant.ownerUserId, 10_000n);
  const order = await ordersService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "takeaway", currency: "PKR" });
  const itemIds: string[] = [];
  for (const seatNumber of seats) {
    const item = await orderItemsService.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId: order.id, productId, seatNumber });
    itemIds.push(item.id);
  }
  await ordersService.close({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId });
  return { orderId: order.id, itemIds };
}

describe("InvoicesService.generate — P2-21 item-scoped billing", () => {
  it("bills only the given itemIds, leaving the rest of the order unbilled", async () => {
    const tenant = await createRestaurant("invoice-item-scoped");
    const branchId = await createBranch(tenant.restaurantId);
    const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
    const { orderId, itemIds } = await createClosedOrderWithSeats(tenant, branchId, [1, 2]);

    const invoice = await service.generate({ restaurantId: tenant.restaurantId, orderId, deviceId: device.id, actorUserId: tenant.ownerUserId, itemIds: [itemIds[0]!] });
    expect(invoice.subtotalMinor).toBe(10_000n);

    // The second item is still unbilled, so a fresh generate() over "everything unbilled" succeeds.
    const second = await service.generate({ restaurantId: tenant.restaurantId, orderId, deviceId: device.id, actorUserId: tenant.ownerUserId });
    expect(second.subtotalMinor).toBe(10_000n);
    expect(second.id).not.toBe(invoice.id);
  });

  it("rejects item ids that don't belong to the order, or are already invoiced", async () => {
    const tenant = await createRestaurant("invoice-item-scoped-rejects");
    const branchId = await createBranch(tenant.restaurantId);
    const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
    const { orderId, itemIds } = await createClosedOrderWithSeats(tenant, branchId, [1, 2]);

    await expect(
      service.generate({ restaurantId: tenant.restaurantId, orderId, deviceId: device.id, actorUserId: tenant.ownerUserId, itemIds: [randomUUID()] }),
    ).rejects.toThrow(NotFoundException);

    await service.generate({ restaurantId: tenant.restaurantId, orderId, deviceId: device.id, actorUserId: tenant.ownerUserId, itemIds: [itemIds[0]!] });
    await expect(
      service.generate({ restaurantId: tenant.restaurantId, orderId, deviceId: device.id, actorUserId: tenant.ownerUserId, itemIds: [itemIds[0]!] }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe("InvoicesService.splitBySeat", () => {
  it("produces one invoice per distinct seat", async () => {
    const tenant = await createRestaurant("invoice-split-seat");
    const branchId = await createBranch(tenant.restaurantId);
    const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
    const { orderId } = await createClosedOrderWithSeats(tenant, branchId, [1, 1, 2]);

    const invoices = await service.splitBySeat({ restaurantId: tenant.restaurantId, orderId, deviceId: device.id, actorUserId: tenant.ownerUserId });

    expect(invoices).toHaveLength(2);
    expect(invoices.map((inv) => inv.subtotalMinor).sort()).toEqual([10_000n, 20_000n]);
  });

  it("groups seat-less items into their own shared invoice", async () => {
    const tenant = await createRestaurant("invoice-split-seat-unassigned");
    const branchId = await createBranch(tenant.restaurantId);
    const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
    const { orderId } = await createClosedOrderWithSeats(tenant, branchId, [1, undefined]);

    const invoices = await service.splitBySeat({ restaurantId: tenant.restaurantId, orderId, deviceId: device.id, actorUserId: tenant.ownerUserId });
    expect(invoices).toHaveLength(2);
  });

  it("rejects splitting an order with nothing left unbilled", async () => {
    const tenant = await createRestaurant("invoice-split-seat-none-left");
    const branchId = await createBranch(tenant.restaurantId);
    const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
    const orderId = await createClosedOrderWithItem(tenant, branchId);
    await service.generate({ restaurantId: tenant.restaurantId, orderId, deviceId: device.id, actorUserId: tenant.ownerUserId });

    await expect(service.splitBySeat({ restaurantId: tenant.restaurantId, orderId, deviceId: device.id, actorUserId: tenant.ownerUserId })).rejects.toThrow(BadRequestException);
  });
});

describe("InvoicesService.splitByItems", () => {
  it("produces one invoice per caller-chosen group", async () => {
    const tenant = await createRestaurant("invoice-split-items");
    const branchId = await createBranch(tenant.restaurantId);
    const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
    const { orderId, itemIds } = await createClosedOrderWithSeats(tenant, branchId, [1, 2, 3]);

    const invoices = await service.splitByItems({
      restaurantId: tenant.restaurantId,
      orderId,
      deviceId: device.id,
      actorUserId: tenant.ownerUserId,
      groups: [[itemIds[0]!, itemIds[1]!], [itemIds[2]!]],
    });

    expect(invoices).toHaveLength(2);
    expect(invoices.map((inv) => inv.subtotalMinor).sort()).toEqual([10_000n, 20_000n]);
  });

  it("rejects an empty group", async () => {
    const tenant = await createRestaurant("invoice-split-items-empty-group");
    const branchId = await createBranch(tenant.restaurantId);
    const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
    const { orderId } = await createClosedOrderWithSeats(tenant, branchId, [1]);

    await expect(
      service.splitByItems({ restaurantId: tenant.restaurantId, orderId, deviceId: device.id, actorUserId: tenant.ownerUserId, groups: [[]] }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe("InvoicesService.listByOrderId", () => {
  it("returns every invoice generated for an order, not just the first", async () => {
    const tenant = await createRestaurant("invoice-list-by-order");
    const branchId = await createBranch(tenant.restaurantId);
    const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
    const { orderId } = await createClosedOrderWithSeats(tenant, branchId, [1, 2]);

    await service.splitBySeat({ restaurantId: tenant.restaurantId, orderId, deviceId: device.id, actorUserId: tenant.ownerUserId });

    const all = await service.listByOrderId({ restaurantId: tenant.restaurantId, orderId });
    expect(all).toHaveLength(2);
  });
});
