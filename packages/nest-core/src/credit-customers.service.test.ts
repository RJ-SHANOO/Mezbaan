import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { CreditCustomersService } from "./credit-customers.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: CreditCustomersService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  service = new CreditCustomersService(db, new AuditLogService(db));
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

describe("CreditCustomersService.chargeInvoice", () => {
  it("charges within the credit limit and increases the balance owed", async () => {
    const tenant = await createRestaurant("credit-charge-ok");
    const customer = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Acme Corp", creditLimitMinor: 10_000n, currency: "PKR" });

    const entry = await service.chargeInvoice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, creditCustomerId: customer.id, amountMinor: 4_000n });
    expect(entry.entryType).toBe("charge");

    const balance = await service.getBalance({ restaurantId: tenant.restaurantId, creditCustomerId: customer.id });
    expect(balance.balanceMinor).toBe(4_000n);
    expect(balance.availableCreditMinor).toBe(6_000n);
  });

  it("rejects a charge that would exceed the credit limit", async () => {
    const tenant = await createRestaurant("credit-charge-exceeds");
    const customer = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Acme Corp", creditLimitMinor: 5_000n, currency: "PKR" });

    await service.chargeInvoice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, creditCustomerId: customer.id, amountMinor: 4_000n });
    await expect(
      service.chargeInvoice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, creditCustomerId: customer.id, amountMinor: 2_000n }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a charge against a deactivated customer", async () => {
    const tenant = await createRestaurant("credit-charge-inactive");
    const customer = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Acme Corp", creditLimitMinor: 10_000n, currency: "PKR" });
    await service.update({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, creditCustomerId: customer.id, isActive: false });

    await expect(
      service.chargeInvoice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, creditCustomerId: customer.id, amountMinor: 1_000n }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a non-positive charge amount", async () => {
    const tenant = await createRestaurant("credit-charge-non-positive");
    const customer = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Acme Corp", creditLimitMinor: 10_000n, currency: "PKR" });

    await expect(
      service.chargeInvoice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, creditCustomerId: customer.id, amountMinor: 0n }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe("CreditCustomersService.recordRepayment", () => {
  it("reduces the balance owed", async () => {
    const tenant = await createRestaurant("credit-repay-ok");
    const customer = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Acme Corp", creditLimitMinor: 10_000n, currency: "PKR" });
    await service.chargeInvoice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, creditCustomerId: customer.id, amountMinor: 8_000n });

    await service.recordRepayment({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, creditCustomerId: customer.id, amountMinor: 3_000n });

    const balance = await service.getBalance({ restaurantId: tenant.restaurantId, creditCustomerId: customer.id });
    expect(balance.balanceMinor).toBe(5_000n);
    expect(balance.availableCreditMinor).toBe(5_000n);
  });

  it("rejects a repayment exceeding what's currently owed", async () => {
    const tenant = await createRestaurant("credit-repay-exceeds");
    const customer = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Acme Corp", creditLimitMinor: 10_000n, currency: "PKR" });
    await service.chargeInvoice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, creditCustomerId: customer.id, amountMinor: 2_000n });

    await expect(
      service.recordRepayment({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, creditCustomerId: customer.id, amountMinor: 2_001n }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe("CreditCustomersService tenant isolation", () => {
  it("never lists another restaurant's credit customers", async () => {
    const tenantA = await createRestaurant("credit-iso-a");
    const tenantB = await createRestaurant("credit-iso-b");
    await service.create({ restaurantId: tenantA.restaurantId, actorUserId: tenantA.ownerUserId, name: "A Corp", currency: "PKR" });

    const listA = await service.list(tenantA.restaurantId);
    const listB = await service.list(tenantB.restaurantId);
    expect(listA).toHaveLength(1);
    expect(listB).toHaveLength(0);
  });

  it("rejects an unknown credit customer", async () => {
    const tenant = await createRestaurant("credit-unknown-customer");
    await expect(service.getBalance({ restaurantId: tenant.restaurantId, creditCustomerId: randomUUID() })).rejects.toThrow(NotFoundException);
  });
});

describe("CreditCustomersService.listLedger", () => {
  it("paginates ledger entries newest-first with a cursor, with no gaps or duplicates across pages", async () => {
    const tenant = await createRestaurant("credit-ledger-pagination");
    const customer = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Acme Corp", creditLimitMinor: 100_000n, currency: "PKR" });

    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const entry = await service.chargeInvoice({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, creditCustomerId: customer.id, amountMinor: 1_000n });
      created.push(entry.id);
    }
    const newestFirst = [...created].reverse();

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 3; i++) {
      const page = await service.listLedger({ restaurantId: tenant.restaurantId, creditCustomerId: customer.id, cursor, limit: 2 });
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor ?? undefined;
      if (!page.nextCursor) break;
    }
    expect(seen).toEqual(newestFirst);
  });

  it("rejects a malformed pagination cursor", async () => {
    const tenant = await createRestaurant("credit-ledger-bad-cursor");
    const customer = await service.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, name: "Acme Corp", currency: "PKR" });
    await expect(service.listLedger({ restaurantId: tenant.restaurantId, creditCustomerId: customer.id, cursor: "not-a-real-cursor" })).rejects.toThrow(BadRequestException);
  });
});
