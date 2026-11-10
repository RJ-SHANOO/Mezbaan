import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { ServiceChargeSettingsService } from "./service-charge-settings.service.js";
import { TaxCalculationService } from "./tax-calculation.service.js";
import { TaxRulesService } from "./tax-rules.service.js";
import { TaxSettingsService } from "./tax-settings.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let taxRulesService: TaxRulesService;
let taxSettingsService: TaxSettingsService;
let serviceChargeSettingsService: ServiceChargeSettingsService;
let calculationService: TaxCalculationService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  taxRulesService = new TaxRulesService(db, auditLogService);
  taxSettingsService = new TaxSettingsService(db, auditLogService);
  serviceChargeSettingsService = new ServiceChargeSettingsService(db, auditLogService);
  calculationService = new TaxCalculationService(taxRulesService, taxSettingsService, serviceChargeSettingsService);
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

describe("TaxCalculationService.previewCharges", () => {
  it("exclusive mode with no service charge configured: tax is added on top of the subtotal", async () => {
    const tenant = await createRestaurant("calc-exclusive-plain");
    const branchId = await createBranch(tenant.restaurantId);
    await taxRulesService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "GST", rateBasisPoints: 1000 });

    const result = await calculationService.previewCharges({
      restaurantId: tenant.restaurantId,
      branchId,
      orderType: "dine_in",
      subtotalMinor: 10_000n,
      currency: "PKR",
    });

    expect(result.pricingMode).toBe("exclusive");
    expect(result.serviceCharge.amountMinor).toBe(0n);
    expect(result.tax.amountMinor).toBe(1_000n);
    expect(result.total.amountMinor).toBe(11_000n);
  });

  it("exclusive mode with a non-taxable service charge: tax ignores the service charge, which is added untaxed on top", async () => {
    const tenant = await createRestaurant("calc-exclusive-nontaxable-svc");
    const branchId = await createBranch(tenant.restaurantId);
    await taxRulesService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "GST", rateBasisPoints: 1000 });
    await serviceChargeSettingsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, rateBasisPoints: 500, isTaxable: false });

    const result = await calculationService.previewCharges({
      restaurantId: tenant.restaurantId,
      branchId,
      orderType: "dine_in",
      subtotalMinor: 10_000n,
      currency: "PKR",
    });

    expect(result.serviceCharge.amountMinor).toBe(500n);
    expect(result.taxBase.amountMinor).toBe(10_000n);
    expect(result.tax.amountMinor).toBe(1_000n);
    expect(result.total.amountMinor).toBe(11_500n);
  });

  it("exclusive mode with a taxable service charge: the service charge is folded into the tax base before tax is computed", async () => {
    const tenant = await createRestaurant("calc-exclusive-taxable-svc");
    const branchId = await createBranch(tenant.restaurantId);
    await taxRulesService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "GST", rateBasisPoints: 1000 });
    await serviceChargeSettingsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, rateBasisPoints: 500, isTaxable: true });

    const result = await calculationService.previewCharges({
      restaurantId: tenant.restaurantId,
      branchId,
      orderType: "dine_in",
      subtotalMinor: 10_000n,
      currency: "PKR",
    });

    expect(result.serviceCharge.amountMinor).toBe(500n);
    expect(result.taxBase.amountMinor).toBe(10_500n);
    expect(result.tax.amountMinor).toBe(1_050n);
    expect(result.total.amountMinor).toBe(11_550n);
  });

  it("inclusive mode: the configured rate is backed out of the subtotal, and the service charge is still added on top untaxed", async () => {
    const tenant = await createRestaurant("calc-inclusive");
    const branchId = await createBranch(tenant.restaurantId);
    await taxSettingsService.set({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, pricingMode: "inclusive" });
    await taxRulesService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "GST", rateBasisPoints: 900 });
    await serviceChargeSettingsService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, rateBasisPoints: 1000, isTaxable: true });

    const result = await calculationService.previewCharges({
      restaurantId: tenant.restaurantId,
      branchId,
      orderType: "dine_in",
      subtotalMinor: 10_900n,
      currency: "PKR",
    });

    expect(result.pricingMode).toBe("inclusive");
    expect(result.taxBase.amountMinor).toBe(10_000n);
    expect(result.tax.amountMinor).toBe(900n);
    expect(result.serviceCharge.amountMinor).toBe(1_090n);
    expect(result.total.amountMinor).toBe(11_990n);
  });

  it("sums multiple applicable tax rules into one combined rate", async () => {
    const tenant = await createRestaurant("calc-multi-rule");
    const branchId = await createBranch(tenant.restaurantId);
    await taxRulesService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "CGST", rateBasisPoints: 450 });
    await taxRulesService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "SGST", rateBasisPoints: 450 });

    const result = await calculationService.previewCharges({
      restaurantId: tenant.restaurantId,
      branchId,
      orderType: "dine_in",
      subtotalMinor: 10_000n,
      currency: "PKR",
    });

    expect(result.taxRateBasisPoints).toBe(900);
    expect(result.appliedTaxRules.map((r) => r.name).sort()).toEqual(["CGST", "SGST"]);
    expect(result.tax.amountMinor).toBe(900n);
  });
});
