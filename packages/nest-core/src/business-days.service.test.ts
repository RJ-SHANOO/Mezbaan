import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { BusinessDaysService } from "./business-days.service.js";
import { OrderItemsService } from "./order-items.service.js";
import { OrdersService } from "./orders.service.js";
import { PriceResolutionService } from "./price-resolution.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: BusinessDaysService;
let ordersServiceWithGate: OrdersService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  service = new BusinessDaysService(db, auditLogService);
  const orderItemsService = new OrderItemsService(db, auditLogService, new PriceResolutionService(db));
  ordersServiceWithGate = new OrdersService(db, auditLogService, orderItemsService, service);
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

async function createBranch(restaurantId: string, timezone = "Asia/Karachi"): Promise<string> {
  const rows = await withTenant(db, { restaurantId }, (tx) =>
    tx.insert(schema.branches).values({ restaurantId, name: "Main", timezone }).returning({ id: schema.branches.id }),
  );
  const branch = rows[0];
  if (!branch) throw new Error("fixture: branch insert returned no row");
  return branch.id;
}

describe("BusinessDaysService.close / getStatus", () => {
  it("a day with no row at all is implicitly open", async () => {
    const tenant = await createRestaurant("bizday-implicit-open");
    const branchId = await createBranch(tenant.restaurantId);

    const status = await service.getStatus({ restaurantId: tenant.restaurantId, branchId });
    expect(status.status).toBe("open");
  });

  it("closes today's business day and reflects it in getStatus", async () => {
    const tenant = await createRestaurant("bizday-close-ok");
    const branchId = await createBranch(tenant.restaurantId);

    const closed = await service.close({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId });
    expect(closed.status).toBe("closed");

    const status = await service.getStatus({ restaurantId: tenant.restaurantId, branchId });
    expect(status.status).toBe("closed");
    expect(status.businessDate).toBe(closed.businessDate);
  });

  it("rejects closing an already-closed day", async () => {
    const tenant = await createRestaurant("bizday-close-twice");
    const branchId = await createBranch(tenant.restaurantId);
    await service.close({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId });

    await expect(service.close({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId })).rejects.toThrow(BadRequestException);
  });

  it("closing one business date doesn't affect a different one", async () => {
    const tenant = await createRestaurant("bizday-different-date");
    const branchId = await createBranch(tenant.restaurantId);
    await service.close({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, businessDate: "2025-01-01" });

    const status = await service.getStatus({ restaurantId: tenant.restaurantId, branchId, businessDate: "2025-01-02" });
    expect(status.status).toBe("open");
  });
});

describe("OrdersService.create business-day gate (P2-30 integration)", () => {
  it("rejects a new order on a closed business day", async () => {
    const tenant = await createRestaurant("bizday-blocks-order");
    const branchId = await createBranch(tenant.restaurantId);
    await service.close({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId });

    await expect(
      ordersServiceWithGate.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "takeaway", currency: "PKR" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("allows an order once the day is open again (a different date)", async () => {
    const tenant = await createRestaurant("bizday-allows-order");
    const branchId = await createBranch(tenant.restaurantId);

    const order = await ordersServiceWithGate.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "takeaway", currency: "PKR" });
    expect(order.status).toBe("open");
  });

  it("asOfBusinessDate lets a synced order bypass today's closure by checking its own original date", async () => {
    const tenant = await createRestaurant("bizday-asof-override");
    const branchId = await createBranch(tenant.restaurantId);
    await service.close({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId });

    // The sale actually happened on a different (still-open) day — e.g. an
    // offline terminal reconnecting after "today" was already closed.
    const order = await ordersServiceWithGate.create({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.ownerUserId,
      branchId,
      orderType: "takeaway",
      currency: "PKR",
      asOfBusinessDate: "2020-01-01",
    });
    expect(order.status).toBe("open");
  });
});

describe("BusinessDaysService.list", () => {
  it("paginates closed business days newest-first with a cursor, with no gaps or duplicates across pages", async () => {
    const tenant = await createRestaurant("bizday-list-pagination");
    const branchId = await createBranch(tenant.restaurantId);

    const dates = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"];
    const created: string[] = [];
    for (const businessDate of dates) {
      const day = await service.close({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, businessDate });
      created.push(day.id);
    }
    const newestFirst = [...created].reverse();

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 3; i++) {
      const page = await service.list(tenant.restaurantId, branchId, cursor, 2);
      seen.push(...page.items.map((d) => d.id));
      cursor = page.nextCursor ?? undefined;
      if (!page.nextCursor) break;
    }
    expect(seen).toEqual(newestFirst);
  });

  it("rejects a malformed pagination cursor", async () => {
    const tenant = await createRestaurant("bizday-list-bad-cursor");
    const branchId = await createBranch(tenant.restaurantId);
    await expect(service.list(tenant.restaurantId, branchId, "not-a-real-cursor")).rejects.toThrow(BadRequestException);
  });
});
