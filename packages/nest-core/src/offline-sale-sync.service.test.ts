import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { OfflineSaleCompletedPayload } from "@mezbaan/contracts";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { CategoriesService } from "./categories.service.js";
import { OfflineSaleSyncService } from "./offline-sale-sync.service.js";
import { PriceListItemsService } from "./price-list-items.service.js";
import { PriceListsService } from "./price-lists.service.js";
import { ProductsService } from "./products.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: OfflineSaleSyncService;
let categoriesService: CategoriesService;
let productsService: ProductsService;
let priceListsService: PriceListsService;
let priceListItemsService: PriceListItemsService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  service = new OfflineSaleSyncService(auditLogService);
  categoriesService = new CategoriesService(db, auditLogService);
  productsService = new ProductsService(db, auditLogService);
  priceListsService = new PriceListsService(db, auditLogService);
  priceListItemsService = new PriceListItemsService(db, auditLogService);
});

afterAll(async () => {
  await pool.end();
});

interface Fixture {
  restaurantId: string;
  branchId: string;
  deviceId: string;
  ownerUserId: string;
}

async function createFixture(label: string, withDefaultActor = true): Promise<Fixture> {
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
      .values({
        restaurantId: restaurant.id,
        branchId: branch.id,
        label: "Till 1",
        deviceType: "pos_terminal",
        defaultActorUserId: withDefaultActor ? owner.id : null,
      })
      .returning({ id: schema.devices.id });
    const device = deviceRows[0];
    if (!device) throw new Error("fixture: device insert returned no row");

    return { restaurantId: restaurant.id, branchId: branch.id, deviceId: device.id, ownerUserId: owner.id };
  });
}

async function createPricedProduct(fixture: Fixture, unitPriceMinor: bigint, currency = "PKR"): Promise<{ productId: string; priceListId: string; priceListVersion: number }> {
  const category = await categoriesService.create({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, name: "Burgers" });
  const product = await productsService.create({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, categoryId: category.id, name: "Cheeseburger" });
  const priceList = await priceListsService.create({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, name: `List-${randomUUID()}`, currency });
  await priceListItemsService.setPrice({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, priceListId: priceList.id, productId: product.id, unitPriceMinor });
  const published = await priceListsService.publish({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, priceListId: priceList.id });
  return { productId: product.id, priceListId: priceList.id, priceListVersion: published.version };
}

function payload(overrides: Partial<OfflineSaleCompletedPayload> = {}): OfflineSaleCompletedPayload {
  return {
    orderType: "takeaway",
    currency: "PKR",
    lines: [],
    documentNumber: `B1-T1-${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`,
    subtotalMinor: "3000",
    serviceChargeMinor: "0",
    taxMinor: "300",
    totalMinor: "3300",
    pricingMode: "exclusive",
    taxRateBasisPoints: 1000,
    serviceChargeRateBasisPoints: null,
    appliedTaxRules: [{ name: "VAT", rateBasisPoints: 1000 }],
    ...overrides,
  };
}

describe("OfflineSaleSyncService.process", () => {
  it("creates a real order, order items and an invoice from a synced offline sale", async () => {
    const fixture = await createFixture("offline-sync-ok");
    const { productId, priceListId, priceListVersion } = await createPricedProduct(fixture, 1500n);

    await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) =>
      service.process(tx, {
        restaurantId: fixture.restaurantId,
        branchId: fixture.branchId,
        deviceId: fixture.deviceId,
        payload: payload({
          lines: [{ productId, name: "Cheeseburger", quantity: 2, unitPriceMinor: "1500", currency: "PKR", priceListId, priceListVersion, modifiers: [] }],
        }),
      }),
    );

    const orders = await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) => tx.select().from(schema.orders));
    expect(orders).toHaveLength(1);
    expect(orders[0]?.status).toBe("closed");
    expect(orders[0]?.openedByUserId).toBe(fixture.ownerUserId);

    const invoices = await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) => tx.select().from(schema.invoices));
    expect(invoices).toHaveLength(1);
    expect(invoices[0]?.documentNumber).toMatch(/^B1-T1-\d{6}$/);
    expect(invoices[0]?.totalMinor).toBe(3300n);
    expect(invoices[0]?.actorUserId).toBe(fixture.ownerUserId);

    const items = await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) => tx.select().from(schema.orderItems));
    expect(items).toHaveLength(1);
    expect(items[0]?.invoiceId).toBe(invoices[0]?.id);
    expect(items[0]?.quantity).toBe(2);

    const history = await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) => tx.select().from(schema.orderStatusHistory));
    expect(history.map((h) => h.toStatus).sort()).toEqual(["closed", "open"]);
  });

  it("rejects a device with no default actor configured, rather than guessing", async () => {
    const fixture = await createFixture("offline-sync-no-actor", false);
    const { productId, priceListId, priceListVersion } = await createPricedProduct(fixture, 1000n);

    await expect(
      withTenant(db, { restaurantId: fixture.restaurantId }, (tx) =>
        service.process(tx, {
          restaurantId: fixture.restaurantId,
          branchId: fixture.branchId,
          deviceId: fixture.deviceId,
          payload: payload({ lines: [{ productId, name: "Cheeseburger", quantity: 1, unitPriceMinor: "1000", currency: "PKR", priceListId, priceListVersion, modifiers: [] }] }),
        }),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects an offline dine-in sale — no table selection exists on the offline cart", async () => {
    const fixture = await createFixture("offline-sync-dine-in");
    const { productId, priceListId, priceListVersion } = await createPricedProduct(fixture, 1000n);

    await expect(
      withTenant(db, { restaurantId: fixture.restaurantId }, (tx) =>
        service.process(tx, {
          restaurantId: fixture.restaurantId,
          branchId: fixture.branchId,
          deviceId: fixture.deviceId,
          payload: payload({ orderType: "dine_in", lines: [{ productId, name: "Cheeseburger", quantity: 1, unitPriceMinor: "1000", currency: "PKR", priceListId, priceListVersion, modifiers: [] }] }),
        }),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects an unknown device", async () => {
    const fixture = await createFixture("offline-sync-unknown-device");
    await expect(
      withTenant(db, { restaurantId: fixture.restaurantId }, (tx) =>
        service.process(tx, { restaurantId: fixture.restaurantId, branchId: fixture.branchId, deviceId: randomUUID(), payload: payload({ lines: [] }) }),
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it("records a modifier line against order_item_modifiers, including a free (unpriced) one", async () => {
    const fixture = await createFixture("offline-sync-modifiers");
    const { productId, priceListId, priceListVersion } = await createPricedProduct(fixture, 1000n);
    const modifierOption = await withTenant(db, { restaurantId: fixture.restaurantId }, async (tx) => {
      const groupRows = await tx.insert(schema.modifierGroups).values({ restaurantId: fixture.restaurantId, name: "Toppings", minSelections: 0 }).returning({ id: schema.modifierGroups.id });
      const optionRows = await tx
        .insert(schema.modifierOptions)
        .values({ restaurantId: fixture.restaurantId, modifierGroupId: groupRows[0]!.id, name: "Extra Cheese" })
        .returning({ id: schema.modifierOptions.id });
      return optionRows[0]!.id;
    });

    await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) =>
      service.process(tx, {
        restaurantId: fixture.restaurantId,
        branchId: fixture.branchId,
        deviceId: fixture.deviceId,
        payload: payload({
          lines: [
            {
              productId,
              name: "Cheeseburger",
              quantity: 1,
              unitPriceMinor: "1000",
              currency: "PKR",
              priceListId,
              priceListVersion,
              modifiers: [{ modifierOptionId: modifierOption, name: "Extra Cheese", unitPriceMinor: "0", currency: "PKR", priceListId: null, priceListVersion: null }],
            },
          ],
        }),
      }),
    );

    const modifiers = await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) => tx.select().from(schema.orderItemModifiers));
    expect(modifiers).toHaveLength(1);
    expect(modifiers[0]?.priceListId).toBeNull();
  });
});
