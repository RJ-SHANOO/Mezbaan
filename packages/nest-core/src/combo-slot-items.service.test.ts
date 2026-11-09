import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { CategoriesService } from "./categories.service.js";
import { ComboSlotItemsService } from "./combo-slot-items.service.js";
import { ComboSlotsService } from "./combo-slots.service.js";
import { CombosService } from "./combos.service.js";
import { ProductsService } from "./products.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: ComboSlotItemsService;
let comboSlotsService: ComboSlotsService;
let combosService: CombosService;
let productsService: ProductsService;
let categoriesService: CategoriesService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  service = new ComboSlotItemsService(db, auditLogService);
  comboSlotsService = new ComboSlotsService(db, auditLogService);
  combosService = new CombosService(db, auditLogService);
  productsService = new ProductsService(db, auditLogService);
  categoriesService = new CategoriesService(db, auditLogService);
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

async function createProduct(restaurantId: string, actorUserId: string, name: string): Promise<string> {
  const category = await categoriesService.create({ restaurantId, actorUserId, name: "Sides" });
  const product = await productsService.create({ restaurantId, actorUserId, categoryId: category.id, name });
  return product.id;
}

async function createSlot(restaurantId: string, actorUserId: string, kind: "fixed" | "choice"): Promise<{ comboId: string; slotId: string }> {
  const combo = await combosService.create({ restaurantId, actorUserId, name: "Deal" });
  const slot = await comboSlotsService.create({ restaurantId, actorUserId, comboId: combo.id, name: "Side", kind });
  return { comboId: combo.id, slotId: slot.id };
}

describe("ComboSlotItemsService", () => {
  it("attaches an item to a choice slot, lists it, and audits the attach", async () => {
    const tenant = await createRestaurant("item-attach-choice");
    const { slotId } = await createSlot(tenant.restaurantId, tenant.ownerUserId, "choice");
    const productId = await createProduct(tenant.restaurantId, tenant.ownerUserId, "Fries");

    await service.attach({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, comboSlotId: slotId, productId });

    const listed = await service.list(tenant.restaurantId, slotId);
    expect(listed.map((i) => i.productId)).toEqual([productId]);

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "combo_slot_item.attached" && row.targetId === slotId)).toBe(true);
  });

  it("a choice slot can have multiple candidate items", async () => {
    const tenant = await createRestaurant("item-choice-multiple");
    const { slotId } = await createSlot(tenant.restaurantId, tenant.ownerUserId, "choice");
    const fries = await createProduct(tenant.restaurantId, tenant.ownerUserId, "Fries");
    const salad = await createProduct(tenant.restaurantId, tenant.ownerUserId, "Salad");

    await service.attach({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, comboSlotId: slotId, productId: fries });
    await service.attach({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, comboSlotId: slotId, productId: salad });

    const listed = await service.list(tenant.restaurantId, slotId);
    expect(listed.map((i) => i.productId).sort()).toEqual([fries, salad].sort());
  });

  it("rejects attaching a second, different item to a fixed slot", async () => {
    const tenant = await createRestaurant("item-fixed-reject-second");
    const { slotId } = await createSlot(tenant.restaurantId, tenant.ownerUserId, "fixed");
    const fries = await createProduct(tenant.restaurantId, tenant.ownerUserId, "Fries");
    const salad = await createProduct(tenant.restaurantId, tenant.ownerUserId, "Salad");

    await service.attach({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, comboSlotId: slotId, productId: fries });

    await expect(
      service.attach({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, comboSlotId: slotId, productId: salad }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("attaching the same item again to a fixed slot updates sortOrder instead of being rejected as a duplicate", async () => {
    const tenant = await createRestaurant("item-fixed-reattach-same");
    const { slotId } = await createSlot(tenant.restaurantId, tenant.ownerUserId, "fixed");
    const fries = await createProduct(tenant.restaurantId, tenant.ownerUserId, "Fries");

    await service.attach({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, comboSlotId: slotId, productId: fries, sortOrder: 1 });
    await service.attach({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, comboSlotId: slotId, productId: fries, sortOrder: 2 });

    const listed = await service.list(tenant.restaurantId, slotId);
    expect(listed).toEqual([expect.objectContaining({ productId: fries, sortOrder: 2 })]);
  });

  it("detaches an item and audits it", async () => {
    const tenant = await createRestaurant("item-detach");
    const { slotId } = await createSlot(tenant.restaurantId, tenant.ownerUserId, "choice");
    const fries = await createProduct(tenant.restaurantId, tenant.ownerUserId, "Fries");
    await service.attach({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, comboSlotId: slotId, productId: fries });

    await service.detach({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, comboSlotId: slotId, productId: fries });

    expect(await service.list(tenant.restaurantId, slotId)).toEqual([]);
    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "combo_slot_item.detached" && row.targetId === slotId)).toBe(true);
  });

  it("rejects attaching an item that belongs to a different tenant's product", async () => {
    const tenantA = await createRestaurant("item-cross-product-a");
    const tenantB = await createRestaurant("item-cross-product-b");
    const { slotId } = await createSlot(tenantA.restaurantId, tenantA.ownerUserId, "choice");
    const productB = await createProduct(tenantB.restaurantId, tenantB.ownerUserId, "B's Product");

    await expect(
      service.attach({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, comboSlotId: slotId, productId: productB }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects attaching to a slot that belongs to a different tenant", async () => {
    const tenantA = await createRestaurant("item-cross-slot-a");
    const tenantB = await createRestaurant("item-cross-slot-b");
    const { slotId: slotB } = await createSlot(tenantB.restaurantId, tenantB.ownerUserId, "choice");
    const productA = await createProduct(tenantA.restaurantId, tenantA.ownerUserId, "A's Product");

    await expect(
      service.attach({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, comboSlotId: slotB, productId: productA }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
