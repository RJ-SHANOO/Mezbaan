import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { CashMovementsService } from "./cash-movements.service.js";
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
import { ShiftReportsService } from "./shift-reports.service.js";
import { ShiftsService } from "./shifts.service.js";
import { TaxCalculationService } from "./tax-calculation.service.js";
import { TaxRulesService } from "./tax-rules.service.js";
import { TaxSettingsService } from "./tax-settings.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: ShiftReportsService;
let shiftsService: ShiftsService;
let cashMovementsService: CashMovementsService;
let deviceService: DeviceService;
let ordersService: OrdersService;
let orderItemsService: OrderItemsService;
let invoicesService: InvoicesService;
let paymentsService: PaymentsService;
let categoriesService: CategoriesService;
let productsService: ProductsService;
let priceListsService: PriceListsService;
let priceListItemsService: PriceListItemsService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  const priceResolutionService = new PriceResolutionService(db);
  deviceService = new DeviceService(db, auditLogService);
  shiftsService = new ShiftsService(db, auditLogService);
  cashMovementsService = new CashMovementsService(db, auditLogService);
  orderItemsService = new OrderItemsService(db, auditLogService, priceResolutionService);
  ordersService = new OrdersService(db, auditLogService, orderItemsService);
  categoriesService = new CategoriesService(db, auditLogService);
  productsService = new ProductsService(db, auditLogService);
  priceListsService = new PriceListsService(db, auditLogService);
  priceListItemsService = new PriceListItemsService(db, auditLogService);
  const taxRulesService = new TaxRulesService(db, auditLogService);
  const taxSettingsService = new TaxSettingsService(db, auditLogService);
  const serviceChargeSettingsService = new ServiceChargeSettingsService(db, auditLogService);
  const taxCalculationService = new TaxCalculationService(taxRulesService, taxSettingsService, serviceChargeSettingsService);
  invoicesService = new InvoicesService(db, auditLogService, taxCalculationService);
  const paymentMethodSettingsService = new PaymentMethodSettingsService(db, auditLogService);
  paymentsService = new PaymentsService(db, auditLogService, paymentMethodSettingsService);
  service = new ShiftReportsService(db);
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

/** Opens a shift on a fresh device, rings up one 10,000-minor cash sale on
 * that same device, and returns everything needed to drive a report. */
async function createShiftWithOneCashSale(tenant: { restaurantId: string; ownerUserId: string }, branchId: string): Promise<{ shiftId: string }> {
  const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
  const shift = await shiftsService.open({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, deviceId: device.id, openingFloatMinor: 5_000n, currency: "PKR" });

  const category = await categoriesService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Burgers" });
  const product = await productsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, categoryId: category.id, name: "Cheeseburger" });
  const priceList = await priceListsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: `List-${randomUUID()}`, currency: "PKR" });
  await priceListItemsService.setPrice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId: priceList.id, productId: product.id, unitPriceMinor: 10_000n });
  await priceListsService.publish({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId: priceList.id });

  const order = await ordersService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "takeaway", currency: "PKR" });
  await orderItemsService.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId: order.id, productId: product.id });
  await ordersService.close({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId });

  const invoice = await invoicesService.generate({ restaurantId: tenant.restaurantId, orderId: order.id, deviceId: device.id, actorUserId: tenant.ownerUserId });
  await paymentsService.record({ restaurantId: tenant.restaurantId, invoiceId: invoice.id, actorUserId: tenant.ownerUserId, method: "cash", amountMinor: invoice.totalMinor });

  return { shiftId: shift.id };
}

describe("ShiftReportsService.getXReport", () => {
  it("reports expected cash as opening float plus cash sales plus cash-in minus cash-out", async () => {
    const tenant = await createRestaurant("shift-report-x-ok");
    const branchId = await createBranch(tenant.restaurantId);
    const { shiftId } = await createShiftWithOneCashSale(tenant, branchId);
    await cashMovementsService.setReasonCode({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, code: "petty_cash", label: "Petty cash" });
    await cashMovementsService.recordCashIn({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, shiftId, amountMinor: 1_000n, reasonCode: "petty_cash" });
    await cashMovementsService.recordCashOut({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, shiftId, amountMinor: 500n, reasonCode: "petty_cash" });

    const report = await service.getXReport({ restaurantId: tenant.restaurantId, shiftId });

    expect(report.cashSalesMinor).toBe(10_000n);
    expect(report.cashInMinor).toBe(1_000n);
    expect(report.cashOutMinor).toBe(500n);
    // 5,000 float + 10,000 cash sale + 1,000 in - 500 out
    expect(report.expectedCashMinor).toBe(15_500n);
  });
});

describe("ShiftReportsService.getZReport", () => {
  it("computes over/short against the shift's counted cash", async () => {
    const tenant = await createRestaurant("shift-report-z-short");
    const branchId = await createBranch(tenant.restaurantId);
    const { shiftId } = await createShiftWithOneCashSale(tenant, branchId);
    // Expected cash = 5,000 float + 10,000 cash sale = 15,000. Counted only 14,000 → short 1,000.
    await shiftsService.close({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, shiftId, denominationCounts: [{ denominationMinor: 14_000n, count: 1 }] });

    const report = await service.getZReport({ restaurantId: tenant.restaurantId, shiftId });

    expect(report.expectedCashMinor).toBe(15_000n);
    expect(report.countedCashMinor).toBe(14_000n);
    expect(report.overShortMinor).toBe(-1_000n);
  });

  it("rejects a Z report for a shift that isn't closed yet", async () => {
    const tenant = await createRestaurant("shift-report-z-not-closed");
    const branchId = await createBranch(tenant.restaurantId);
    const { shiftId } = await createShiftWithOneCashSale(tenant, branchId);

    await expect(service.getZReport({ restaurantId: tenant.restaurantId, shiftId })).rejects.toThrow(BadRequestException);
  });
});
