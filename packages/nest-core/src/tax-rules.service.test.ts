import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { TaxRulesService } from "./tax-rules.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: TaxRulesService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  service = new TaxRulesService(db, new AuditLogService(db));
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

describe("TaxRulesService", () => {
  it("creates a tax rule, lists it, and audits the creation", async () => {
    const tenant = await createRestaurant("tax-create");
    const rule = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "GST", rateBasisPoints: 1700 });

    expect(rule.isActive).toBe(true);
    const listed = await service.list(tenant.restaurantId);
    expect(listed.map((r) => r.id)).toContain(rule.id);

    const auditRows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) => tx.select().from(schema.auditLogs));
    expect(auditRows.some((row) => row.action === "tax_rule.created" && row.targetId === rule.id)).toBe(true);
  });

  it("rejects a branchId from another restaurant", async () => {
    const tenant = await createRestaurant("tax-cross-branch");
    const otherTenant = await createRestaurant("tax-cross-branch-other");
    const otherBranchId = await createBranch(otherTenant.restaurantId);

    await expect(
      service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "GST", rateBasisPoints: 1700, branchId: otherBranchId }),
    ).rejects.toThrow(NotFoundException);
  });

  it("update rejects an unknown tax rule id", async () => {
    const tenant = await createRestaurant("tax-update-missing");
    await expect(
      service.update({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, taxRuleId: randomUUID(), isActive: false }),
    ).rejects.toThrow(NotFoundException);
  });

  describe("resolveApplicable", () => {
    it("sums multiple active rules matching the same scope (compound tax)", async () => {
      const tenant = await createRestaurant("tax-resolve-sum");
      await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "CGST", rateBasisPoints: 900 });
      await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "SGST", rateBasisPoints: 900 });

      const resolved = await service.resolveApplicable({ restaurantId: tenant.restaurantId, branchId: randomUUID(), orderType: "dine_in" });
      expect(resolved.map((r) => r.name).sort()).toEqual(["CGST", "SGST"]);
      expect(resolved.reduce((sum, r) => sum + r.rateBasisPoints, 0)).toBe(1800);
    });

    it("prefers a branch-specific rule over a restaurant-wide default of the same name, instead of summing both", async () => {
      const tenant = await createRestaurant("tax-resolve-override");
      const branchId = await createBranch(tenant.restaurantId);
      await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "GST", rateBasisPoints: 1700 });
      await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "GST", rateBasisPoints: 0, branchId });

      const resolved = await service.resolveApplicable({ restaurantId: tenant.restaurantId, branchId, orderType: "dine_in" });
      expect(resolved).toEqual([{ name: "GST", rateBasisPoints: 0 }]);
    });

    it("excludes an inactive rule and a rule scoped to a different order type", async () => {
      const tenant = await createRestaurant("tax-resolve-exclude");
      const rule = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "GST", rateBasisPoints: 1700 });
      await service.update({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, taxRuleId: rule.id, isActive: false });
      await service.create({
        restaurantId: tenant.restaurantId,
        actorUserId: tenant.ownerUserId,
        name: "Delivery Levy",
        rateBasisPoints: 300,
        orderType: "delivery",
      });

      const resolved = await service.resolveApplicable({ restaurantId: tenant.restaurantId, branchId: randomUUID(), orderType: "dine_in" });
      expect(resolved).toEqual([]);
    });
  });
});
