import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { CategoriesService } from "./categories.service.js";
import { DeviceService } from "./device.service.js";
import { InvoicesService } from "./invoices.service.js";
import { ManagerPinService } from "./manager-pin.service.js";
import { OrderItemsService } from "./order-items.service.js";
import { OrdersService } from "./orders.service.js";
import { PaymentMethodSettingsService } from "./payment-method-settings.service.js";
import { PaymentsService } from "./payments.service.js";
import { PermissionsService } from "./permissions.service.js";
import { PriceListItemsService } from "./price-list-items.service.js";
import { PriceListsService } from "./price-lists.service.js";
import { PriceResolutionService } from "./price-resolution.service.js";
import { ProductsService } from "./products.service.js";
import { RecipesService } from "./recipes.service.js";
import { RefundsService } from "./refunds.service.js";
import { StockLedgerService } from "./stock-ledger.service.js";
import { StockLevelsService } from "./stock-levels.service.js";
import { NegativeStockFlagsService } from "./negative-stock-flags.service.js";
import { ServiceChargeSettingsService } from "./service-charge-settings.service.js";
import { TaxCalculationService } from "./tax-calculation.service.js";
import { TaxRulesService } from "./tax-rules.service.js";
import { TaxSettingsService } from "./tax-settings.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: RefundsService;
let managerPinService: ManagerPinService;
let ordersService: OrdersService;
let orderItemsService: OrderItemsService;
let invoicesService: InvoicesService;
let paymentsService: PaymentsService;
let deviceService: DeviceService;
let categoriesService: CategoriesService;
let productsService: ProductsService;
let priceListsService: PriceListsService;
let priceListItemsService: PriceListItemsService;
let managerRoleId: string;

beforeAll(async () => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  const priceResolutionService = new PriceResolutionService(db);
  const permissionsService = new PermissionsService(db);
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
  const paymentMethodSettingsService = new PaymentMethodSettingsService(db, auditLogService);
  paymentsService = new PaymentsService(db, auditLogService, paymentMethodSettingsService);
  managerPinService = new ManagerPinService(db, permissionsService, auditLogService, {});
  const recipesService = new RecipesService(db, auditLogService);
  const stockLevelsService = new StockLevelsService(db);
  const negativeStockFlagsService = new NegativeStockFlagsService(db, auditLogService);
  const stockLedgerService = new StockLedgerService(db, auditLogService, stockLevelsService, negativeStockFlagsService);
  service = new RefundsService(db, auditLogService, managerPinService, recipesService, stockLedgerService);

  // Same "don't depend on seed.ts having run" reasoning as discounts/voids tests —
  // grant the real billing.refund.approve key directly, idempotently, since
  // RefundsService hardcodes that exact string.
  const roleRows = await db
    .insert(schema.roles)
    .values({ key: "branch_manager", name: "Branch Manager" })
    .onConflictDoUpdate({ target: schema.roles.key, set: { name: schema.roles.name } })
    .returning({ id: schema.roles.id });
  managerRoleId = roleRows[0]?.id ?? "";
  if (!managerRoleId) throw new Error("fixture: role insert returned no row");

  const permissionRows = await db
    .insert(schema.permissions)
    .values({ key: "billing.refund.approve", description: "test fixture" })
    .onConflictDoUpdate({ target: schema.permissions.key, set: { description: schema.permissions.description } })
    .returning({ id: schema.permissions.id });
  const permissionId = permissionRows[0]?.id;
  if (!permissionId) throw new Error("fixture: permission insert returned no row");
  await db.insert(schema.rolePermissions).values({ roleId: managerRoleId, permissionId }).onConflictDoNothing();
});

afterAll(async () => {
  await pool.end();
});

interface Tenant {
  restaurantId: string;
  ownerUserId: string;
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

  const ownerRoleRows = await db
    .insert(schema.roles)
    .values({ key: "owner", name: "Restaurant Owner" })
    .onConflictDoUpdate({ target: schema.roles.key, set: { name: "Restaurant Owner" } })
    .returning({ id: schema.roles.id });
  const ownerRoleId = ownerRoleRows[0]?.id;
  if (!ownerRoleId) throw new Error("fixture: role insert returned no row");

  const ownerRows = await withTenant(db, { restaurantId: restaurant.id }, (tx) =>
    tx
      .insert(schema.users)
      .values({ restaurantId: restaurant.id, roleId: ownerRoleId, email: `${label}@example.test`, passwordHash: "unused", displayName: label })
      .returning({ id: schema.users.id }),
  );
  const owner = ownerRows[0];
  if (!owner) throw new Error("fixture: user insert returned no row");

  return { restaurantId: restaurant.id, ownerUserId: owner.id };
}

async function createManager(tenant: Tenant, label: string, pin: string): Promise<string> {
  const rows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) =>
    tx
      .insert(schema.users)
      .values({ restaurantId: tenant.restaurantId, roleId: managerRoleId, email: `${label}@example.test`, passwordHash: "unused", displayName: label })
      .returning({ id: schema.users.id }),
  );
  const manager = rows[0];
  if (!manager) throw new Error("fixture: manager insert returned no row");
  await managerPinService.setPin({ restaurantId: tenant.restaurantId, userId: manager.id, pin });
  return manager.id;
}

async function createBranch(restaurantId: string): Promise<string> {
  const rows = await withTenant(db, { restaurantId }, (tx) =>
    tx.insert(schema.branches).values({ restaurantId, name: "Main", timezone: "Asia/Karachi" }).returning({ id: schema.branches.id }),
  );
  const branch = rows[0];
  if (!branch) throw new Error("fixture: branch insert returned no row");
  return branch.id;
}

/** A fully paid invoice with no tax configured, so totalMinor == the item's own price — keeps refund-amount math simple to assert on. */
async function createPaidInvoice(tenant: Tenant, branchId: string, unitPriceMinor = 10_000n): Promise<string> {
  const category = await categoriesService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Burgers" });
  const product = await productsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, categoryId: category.id, name: "Cheeseburger" });
  const priceList = await priceListsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: `List-${randomUUID()}`, currency: "PKR" });
  await priceListItemsService.setPrice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId: priceList.id, productId: product.id, unitPriceMinor });
  await priceListsService.publish({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, priceListId: priceList.id });

  const order = await ordersService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "takeaway", currency: "PKR" });
  await orderItemsService.addItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId: order.id, productId: product.id });
  await ordersService.close({ restaurantId: tenant.restaurantId, orderId: order.id, actorUserId: tenant.ownerUserId });

  const device = await deviceService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, label: "Till 1", deviceType: "pos_terminal" });
  const invoice = await invoicesService.generate({ restaurantId: tenant.restaurantId, orderId: order.id, deviceId: device.id, actorUserId: tenant.ownerUserId });
  await paymentsService.record({ restaurantId: tenant.restaurantId, invoiceId: invoice.id, actorUserId: tenant.ownerUserId, method: "cash", amountMinor: invoice.totalMinor });

  return invoice.id;
}

async function setMistakeReasonCode(tenant: Tenant): Promise<void> {
  await service.setReasonCode({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, code: "mistake", label: "Order entry mistake" });
}

describe("RefundsService.issue", () => {
  it("issues a full refund with manager approval, and records who approved it", async () => {
    const tenant = await createRestaurant("refund-full-ok");
    const branchId = await createBranch(tenant.restaurantId);
    await setMistakeReasonCode(tenant);
    const managerId = await createManager(tenant, "refund-approver", "4321");
    const invoiceId = await createPaidInvoice(tenant, branchId, 10_000n);

    const refund = await service.issue({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, invoiceId, amountMinor: 10_000n, reasonCode: "mistake", managerUserId: managerId, managerPin: "4321" });

    expect(refund.amountMinor).toBe(10_000n);
    expect(refund.approvedByUserId).toBe(managerId);

    const balance = await service.getBalance({ restaurantId: tenant.restaurantId, invoiceId });
    expect(balance.refundableMinor).toBe(0n);
  });

  it("issues a partial refund, leaving the rest refundable", async () => {
    const tenant = await createRestaurant("refund-partial-ok");
    const branchId = await createBranch(tenant.restaurantId);
    await setMistakeReasonCode(tenant);
    const managerId = await createManager(tenant, "refund-partial-approver", "4321");
    const invoiceId = await createPaidInvoice(tenant, branchId, 10_000n);

    await service.issue({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, invoiceId, amountMinor: 4_000n, reasonCode: "mistake", managerUserId: managerId, managerPin: "4321" });

    const balance = await service.getBalance({ restaurantId: tenant.restaurantId, invoiceId });
    expect(balance.refundedMinor).toBe(4_000n);
    expect(balance.refundableMinor).toBe(6_000n);
  });

  it("rejects an amount exceeding what's left to refund", async () => {
    const tenant = await createRestaurant("refund-exceeds-balance");
    const branchId = await createBranch(tenant.restaurantId);
    await setMistakeReasonCode(tenant);
    const managerId = await createManager(tenant, "refund-exceeds-approver", "4321");
    const invoiceId = await createPaidInvoice(tenant, branchId, 10_000n);

    await expect(
      service.issue({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, invoiceId, amountMinor: 10_001n, reasonCode: "mistake", managerUserId: managerId, managerPin: "4321" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a second refund that would exceed what the first left refundable", async () => {
    const tenant = await createRestaurant("refund-second-exceeds");
    const branchId = await createBranch(tenant.restaurantId);
    await setMistakeReasonCode(tenant);
    const managerId = await createManager(tenant, "refund-second-approver", "4321");
    const invoiceId = await createPaidInvoice(tenant, branchId, 10_000n);

    await service.issue({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, invoiceId, amountMinor: 6_000n, reasonCode: "mistake", managerUserId: managerId, managerPin: "4321" });

    await expect(
      service.issue({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, invoiceId, amountMinor: 5_000n, reasonCode: "mistake", managerUserId: managerId, managerPin: "4321" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a wrong manager PIN", async () => {
    const tenant = await createRestaurant("refund-wrong-pin");
    const branchId = await createBranch(tenant.restaurantId);
    await setMistakeReasonCode(tenant);
    const managerId = await createManager(tenant, "refund-wrong-pin-approver", "4321");
    const invoiceId = await createPaidInvoice(tenant, branchId, 10_000n);

    await expect(
      service.issue({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, invoiceId, amountMinor: 1_000n, reasonCode: "mistake", managerUserId: managerId, managerPin: "0000" }),
    ).rejects.toThrow(ForbiddenException);
  });

  it("rejects a non-positive amount", async () => {
    const tenant = await createRestaurant("refund-non-positive");
    const branchId = await createBranch(tenant.restaurantId);
    await setMistakeReasonCode(tenant);
    const managerId = await createManager(tenant, "refund-non-positive-approver", "4321");
    const invoiceId = await createPaidInvoice(tenant, branchId, 10_000n);

    await expect(
      service.issue({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, invoiceId, amountMinor: 0n, reasonCode: "mistake", managerUserId: managerId, managerPin: "4321" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects an unknown or inactive reason code", async () => {
    const tenant = await createRestaurant("refund-bad-reason");
    const branchId = await createBranch(tenant.restaurantId);
    const managerId = await createManager(tenant, "refund-bad-reason-approver", "4321");
    const invoiceId = await createPaidInvoice(tenant, branchId, 10_000n);

    await expect(
      service.issue({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, invoiceId, amountMinor: 1_000n, reasonCode: "nonexistent", managerUserId: managerId, managerPin: "4321" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects an unknown invoice", async () => {
    const tenant = await createRestaurant("refund-unknown-invoice");
    await setMistakeReasonCode(tenant);
    const managerId = await createManager(tenant, "refund-unknown-invoice-approver", "4321");

    await expect(
      service.issue({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, invoiceId: randomUUID(), amountMinor: 1_000n, reasonCode: "mistake", managerUserId: managerId, managerPin: "4321" }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe("RefundsService reason codes", () => {
  it("lists reason codes, and setReasonCode upserts rather than duplicating", async () => {
    const tenant = await createRestaurant("refund-reason-upsert");
    await service.setReasonCode({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, code: "spoiled", label: "Food quality issue" });
    await service.setReasonCode({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, code: "spoiled", label: "Food quality issue (updated)" });

    const codes = await service.listReasonCodes(tenant.restaurantId);
    expect(codes).toHaveLength(1);
    expect(codes[0]?.label).toBe("Food quality issue (updated)");
  });
});
