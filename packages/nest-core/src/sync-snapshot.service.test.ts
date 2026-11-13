import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { SnapshotMenu } from "@mezbaan/contracts";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { CategoriesService } from "./categories.service.js";
import { ModifierGroupsService } from "./modifier-groups.service.js";
import { ModifierOptionsService } from "./modifier-options.service.js";
import { PriceListItemsService } from "./price-list-items.service.js";
import { PriceListsService } from "./price-lists.service.js";
import { PriceResolutionService } from "./price-resolution.service.js";
import { ProductsService } from "./products.service.js";
import { verifyBytes } from "./snapshot-signing.js";
import { SyncSnapshotService } from "./sync-snapshot.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: SyncSnapshotService;
let categoriesService: CategoriesService;
let productsService: ProductsService;
let priceListsService: PriceListsService;
let priceListItemsService: PriceListItemsService;
let modifierGroupsService: ModifierGroupsService;
let modifierOptionsService: ModifierOptionsService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  service = new SyncSnapshotService(db, new PriceResolutionService(db));
  categoriesService = new CategoriesService(db, auditLogService);
  productsService = new ProductsService(db, auditLogService);
  priceListsService = new PriceListsService(db, auditLogService);
  priceListItemsService = new PriceListItemsService(db, auditLogService);
  modifierGroupsService = new ModifierGroupsService(db, auditLogService);
  modifierOptionsService = new ModifierOptionsService(db, auditLogService);
});

afterAll(async () => {
  await pool.end();
});

async function ownerRoleId(): Promise<string> {
  const rows = await db.insert(schema.roles).values({ key: "owner", name: "Restaurant Owner" }).onConflictDoUpdate({ target: schema.roles.key, set: { name: "Restaurant Owner" } }).returning({ id: schema.roles.id });
  const id = rows[0]?.id;
  if (!id) throw new Error("fixture: role insert returned no row");
  return id;
}

async function createFixture(label: string): Promise<{ restaurantId: string; branchId: string; ownerUserId: string }> {
  const restaurantRows = await withTenant(db, { restaurantId: null, isSuperAdmin: true }, (tx) =>
    tx.insert(schema.restaurants).values({ name: label, slug: `${label}-${randomUUID()}`, commissionRateBasisPoints: 500 }).returning({ id: schema.restaurants.id }),
  );
  const restaurantId = restaurantRows[0]?.id;
  if (!restaurantId) throw new Error("fixture: restaurant insert returned no row");

  return withTenant(db, { restaurantId }, async (tx) => {
    const branchRows = await tx.insert(schema.branches).values({ restaurantId, name: "Main", timezone: "Asia/Karachi" }).returning({ id: schema.branches.id });
    const branchId = branchRows[0]?.id;
    if (!branchId) throw new Error("fixture: branch insert returned no row");

    const ownerRows = await tx
      .insert(schema.users)
      .values({ restaurantId, branchId, roleId: await ownerRoleId(), email: `${label}@example.test`, passwordHash: "unused", displayName: label })
      .returning({ id: schema.users.id });
    const ownerUserId = ownerRows[0]?.id;
    if (!ownerUserId) throw new Error("fixture: user insert returned no row");

    return { restaurantId, branchId, ownerUserId };
  });
}

async function publishPriceForProduct(restaurantId: string, actorUserId: string, productId: string, unitPriceMinor: bigint): Promise<{ priceListId: string; version: number }> {
  const priceList = await priceListsService.create({ restaurantId, actorUserId, name: "Standard", currency: "PKR" });
  await priceListItemsService.setPrice({ restaurantId, actorUserId, priceListId: priceList.id, productId, unitPriceMinor });
  const published = await priceListsService.publish({ restaurantId, actorUserId, priceListId: priceList.id });
  return { priceListId: published.id, version: published.version };
}

function parseMenu(contentJson: string): SnapshotMenu {
  return (JSON.parse(contentJson) as { menu: SnapshotMenu }).menu;
}

describe("SyncSnapshotService", () => {
  it("builds a snapshot whose signature verifies against its own content bytes", async () => {
    const fixture = await createFixture("snapshot-sign");

    const snapshot = await service.buildSnapshot(fixture.restaurantId, fixture.branchId);

    expect(verifyBytes(snapshot.contentJson, snapshot.signature)).toBe(true);
    expect(verifyBytes(snapshot.contentJson + "tampered", snapshot.signature)).toBe(false);
  });

  it("includes branches and staff, with a null pinHash for a user who hasn't set one", async () => {
    const fixture = await createFixture("snapshot-staff");

    const snapshot = await service.buildSnapshot(fixture.restaurantId, fixture.branchId);
    const content = JSON.parse(snapshot.contentJson) as { restaurantId: string; branches: Array<{ id: string }>; staff: Array<{ id: string; roleKey: string; pinHash: string | null }> };

    expect(content.restaurantId).toBe(fixture.restaurantId);
    expect(content.branches.map((b) => b.id)).toContain(fixture.branchId);
    const owner = content.staff.find((s) => s.id === fixture.ownerUserId);
    expect(owner).toMatchObject({ roleKey: "owner", pinHash: null });
  });

  it("includes a manager's PIN hash once one is set", async () => {
    const fixture = await createFixture("snapshot-pin");
    await withTenant(db, { restaurantId: fixture.restaurantId }, (tx) =>
      tx.insert(schema.managerPins).values({ restaurantId: fixture.restaurantId, userId: fixture.ownerUserId, pinHash: "scrypt:fake-hash" }),
    );

    const snapshot = await service.buildSnapshot(fixture.restaurantId, fixture.branchId);
    const content = JSON.parse(snapshot.contentJson) as { staff: Array<{ id: string; pinHash: string | null }> };

    expect(content.staff.find((s) => s.id === fixture.ownerUserId)?.pinHash).toBe("scrypt:fake-hash");
  });

  it("never includes another restaurant's staff or branches", async () => {
    const a = await createFixture("snapshot-iso-a");
    const b = await createFixture("snapshot-iso-b");

    const snapshotA = await service.buildSnapshot(a.restaurantId, a.branchId);
    const content = JSON.parse(snapshotA.contentJson) as { staff: Array<{ id: string }>; branches: Array<{ id: string }> };

    expect(content.staff.map((s) => s.id)).not.toContain(b.ownerUserId);
    expect(content.branches.map((br) => br.id)).not.toContain(b.branchId);
  });

  describe("menu", () => {
    it("includes an active category and product, with a resolved price for every order type", async () => {
      const fixture = await createFixture("snapshot-menu-basic");
      const category = await categoriesService.create({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, name: "Burgers" });
      const product = await productsService.create({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, categoryId: category.id, name: "Cheeseburger" });
      const { priceListId, version } = await publishPriceForProduct(fixture.restaurantId, fixture.ownerUserId, product.id, 1500n);

      const snapshot = await service.buildSnapshot(fixture.restaurantId, fixture.branchId);
      const menu = parseMenu(snapshot.contentJson);

      expect(menu.branchId).toBe(fixture.branchId);
      expect(menu.categories.map((c) => c.id)).toContain(category.id);
      expect(menu.products.map((p) => p.id)).toContain(product.id);

      const pricesForProduct = menu.prices.filter((p) => p.productId === product.id);
      expect(pricesForProduct).toHaveLength(3);
      for (const price of pricesForProduct) {
        expect(price.unitPriceMinor).toBe("1500");
        expect(price.priceListId).toBe(priceListId);
        expect(price.priceListVersion).toBe(version);
      }
    });

    it("excludes an inactive product", async () => {
      const fixture = await createFixture("snapshot-menu-inactive");
      const category = await categoriesService.create({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, name: "Burgers" });
      const product = await productsService.create({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, categoryId: category.id, name: "Cheeseburger" });
      await productsService.update({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, productId: product.id, status: "inactive" });

      const snapshot = await service.buildSnapshot(fixture.restaurantId, fixture.branchId);
      const menu = parseMenu(snapshot.contentJson);

      expect(menu.products.map((p) => p.id)).not.toContain(product.id);
    });

    it("excludes a product explicitly marked unavailable at this branch", async () => {
      const fixture = await createFixture("snapshot-menu-unavailable");
      const category = await categoriesService.create({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, name: "Burgers" });
      const product = await productsService.create({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, categoryId: category.id, name: "Cheeseburger" });
      await productsService.setBranchAvailability({
        restaurantId: fixture.restaurantId,
        actorUserId: fixture.ownerUserId,
        productId: product.id,
        branchId: fixture.branchId,
        available: false,
      });

      const snapshot = await service.buildSnapshot(fixture.restaurantId, fixture.branchId);
      const menu = parseMenu(snapshot.contentJson);

      expect(menu.products.map((p) => p.id)).not.toContain(product.id);
    });

    it("includes a product with no override at a different branch, even though it's excluded at the first", async () => {
      const fixture = await createFixture("snapshot-menu-per-branch");
      const otherBranchId = await withTenant(db, { restaurantId: fixture.restaurantId }, async (tx) => {
        const rows = await tx.insert(schema.branches).values({ restaurantId: fixture.restaurantId, name: "Other", timezone: "Asia/Karachi" }).returning({ id: schema.branches.id });
        const id = rows[0]?.id;
        if (!id) throw new Error("fixture: branch insert returned no row");
        return id;
      });
      const category = await categoriesService.create({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, name: "Burgers" });
      const product = await productsService.create({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, categoryId: category.id, name: "Cheeseburger" });
      await productsService.setBranchAvailability({
        restaurantId: fixture.restaurantId,
        actorUserId: fixture.ownerUserId,
        productId: product.id,
        branchId: fixture.branchId,
        available: false,
      });

      const snapshotForOtherBranch = await service.buildSnapshot(fixture.restaurantId, otherBranchId);
      const menu = parseMenu(snapshotForOtherBranch.contentJson);

      expect(menu.products.map((p) => p.id)).toContain(product.id);
    });

    it("has no price entries when nothing has been priced yet, rather than erroring", async () => {
      const fixture = await createFixture("snapshot-menu-unpriced");
      const category = await categoriesService.create({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, name: "Burgers" });
      await productsService.create({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, categoryId: category.id, name: "Cheeseburger" });

      const snapshot = await service.buildSnapshot(fixture.restaurantId, fixture.branchId);
      const menu = parseMenu(snapshot.contentJson);

      expect(menu.prices).toEqual([]);
    });

    it("includes a modifier group/option attached to a product, with a resolved price for the option (P2-12)", async () => {
      const fixture = await createFixture("snapshot-menu-modifiers");
      const category = await categoriesService.create({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, name: "Burgers" });
      const product = await productsService.create({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, categoryId: category.id, name: "Cheeseburger" });
      const group = await modifierGroupsService.create({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, name: "Toppings", minSelections: 0 });
      const option = await modifierOptionsService.create({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, modifierGroupId: group.id, name: "Extra Cheese" });
      await productsService.attachModifierGroup({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, productId: product.id, modifierGroupId: group.id });
      const priceList = await priceListsService.create({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, name: "Mods", currency: "PKR" });
      await priceListItemsService.setPrice({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, priceListId: priceList.id, modifierOptionId: option.id, unitPriceMinor: 150n });
      await priceListsService.publish({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, priceListId: priceList.id });

      const snapshot = await service.buildSnapshot(fixture.restaurantId, fixture.branchId);
      const menu = parseMenu(snapshot.contentJson);

      expect(menu.modifierGroups.map((g) => g.id)).toContain(group.id);
      expect(menu.modifierOptions.map((o) => o.id)).toContain(option.id);
      expect(menu.productModifierGroups).toContainEqual(expect.objectContaining({ productId: product.id, modifierGroupId: group.id }));
      const pricesForOption = menu.prices.filter((p) => p.modifierOptionId === option.id);
      expect(pricesForOption).toHaveLength(3);
      expect(pricesForOption[0]?.unitPriceMinor).toBe("150");
    });

    it("excludes a modifier group only attached to a product that isn't offered at this branch", async () => {
      const fixture = await createFixture("snapshot-menu-modifiers-unavailable");
      const category = await categoriesService.create({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, name: "Burgers" });
      const product = await productsService.create({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, categoryId: category.id, name: "Cheeseburger" });
      const group = await modifierGroupsService.create({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, name: "Toppings" });
      const option = await modifierOptionsService.create({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, modifierGroupId: group.id, name: "Extra Cheese" });
      await productsService.attachModifierGroup({ restaurantId: fixture.restaurantId, actorUserId: fixture.ownerUserId, productId: product.id, modifierGroupId: group.id });
      await productsService.setBranchAvailability({
        restaurantId: fixture.restaurantId,
        actorUserId: fixture.ownerUserId,
        productId: product.id,
        branchId: fixture.branchId,
        available: false,
      });

      const snapshot = await service.buildSnapshot(fixture.restaurantId, fixture.branchId);
      const menu = parseMenu(snapshot.contentJson);

      expect(menu.modifierGroups.map((g) => g.id)).not.toContain(group.id);
      expect(menu.modifierOptions.map((o) => o.id)).not.toContain(option.id);
    });

    it("never includes another restaurant's menu", async () => {
      const a = await createFixture("snapshot-menu-iso-a");
      const b = await createFixture("snapshot-menu-iso-b");
      const category = await categoriesService.create({ restaurantId: b.restaurantId, actorUserId: b.ownerUserId, name: "Burgers" });
      await productsService.create({ restaurantId: b.restaurantId, actorUserId: b.ownerUserId, categoryId: category.id, name: "Cheeseburger" });

      const snapshotA = await service.buildSnapshot(a.restaurantId, a.branchId);
      const menuA = parseMenu(snapshotA.contentJson);

      expect(menuA.categories).toEqual([]);
      expect(menuA.products).toEqual([]);
    });
  });
});
