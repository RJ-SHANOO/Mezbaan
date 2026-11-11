import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import type { Pool } from "pg";
import { AuditLogService } from "./audit-log.service.js";
import { DeliveryDetailsService } from "./delivery-details.service.js";
import { DeliveryRidersService } from "./delivery-riders.service.js";
import { OrdersService } from "./orders.service.js";

const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

let pool: Pool;
let db: Database;
let service: DeliveryDetailsService;
let ridersService: DeliveryRidersService;
let ordersService: OrdersService;

beforeAll(() => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);
  const auditLogService = new AuditLogService(db);
  service = new DeliveryDetailsService(db, auditLogService);
  ridersService = new DeliveryRidersService(db, auditLogService);
  ordersService = new OrdersService(db, auditLogService);
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

async function createDeliveryOrder(restaurantId: string, actorUserId: string, branchId: string): Promise<string> {
  const order = await ordersService.create({ restaurantId, actorUserId, branchId, orderType: "delivery", currency: "PKR" });
  return order.id;
}

describe("DeliveryDetailsService", () => {
  it("sets delivery details on a delivery order, and reading it back matches", async () => {
    const tenant = await createRestaurant("delivery-set");
    const branchId = await createBranch(tenant.restaurantId);
    const orderId = await createDeliveryOrder(tenant.restaurantId, tenant.ownerUserId, branchId);

    const details = await service.setDetails({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.ownerUserId,
      orderId,
      customerName: "Ali",
      customerPhone: "0300-1234567",
      addressLine1: "123 Main St",
    });
    expect(details.deliveryStatus).toBe("pending");
    expect(details.riderId).toBeNull();

    const fetched = await service.get(tenant.restaurantId, orderId);
    expect(fetched?.customerName).toBe("Ali");
  });

  it("setting details twice updates the same row rather than duplicating", async () => {
    const tenant = await createRestaurant("delivery-upsert");
    const branchId = await createBranch(tenant.restaurantId);
    const orderId = await createDeliveryOrder(tenant.restaurantId, tenant.ownerUserId, branchId);

    const first = await service.setDetails({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.ownerUserId,
      orderId,
      customerName: "Ali",
      customerPhone: "0300",
      addressLine1: "First Address",
    });
    const second = await service.setDetails({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.ownerUserId,
      orderId,
      customerName: "Ali",
      customerPhone: "0300",
      addressLine1: "Corrected Address",
    });

    expect(second.id).toBe(first.id);
    expect(second.addressLine1).toBe("Corrected Address");
  });

  it("rejects setting delivery details on a non-delivery order", async () => {
    const tenant = await createRestaurant("delivery-not-delivery");
    const branchId = await createBranch(tenant.restaurantId);
    const order = await ordersService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, orderType: "takeaway", currency: "PKR" });

    await expect(
      service.setDetails({
        restaurantId: tenant.restaurantId,
        actorUserId: tenant.ownerUserId,
        orderId: order.id,
        customerName: "Ali",
        customerPhone: "0300",
        addressLine1: "123 Main St",
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("assigning a rider bumps pending to assigned, but leaves a later status untouched", async () => {
    const tenant = await createRestaurant("delivery-assign");
    const branchId = await createBranch(tenant.restaurantId);
    const orderId = await createDeliveryOrder(tenant.restaurantId, tenant.ownerUserId, branchId);
    await service.setDetails({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, customerName: "Ali", customerPhone: "0300", addressLine1: "123 Main St" });
    const rider = await ridersService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, name: "Zain", phone: "0300" });

    const assigned = await service.assignRider({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, riderId: rider.id });
    expect(assigned.riderId).toBe(rider.id);
    expect(assigned.deliveryStatus).toBe("assigned");

    await service.updateStatus({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, status: "out_for_delivery" });
    const anotherRider = await ridersService.create({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, branchId, name: "Bilal", phone: "0301" });
    const reassigned = await service.assignRider({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, riderId: anotherRider.id });
    expect(reassigned.deliveryStatus).toBe("out_for_delivery");
  });

  it("rejects assigning a rider from another restaurant", async () => {
    const tenant = await createRestaurant("delivery-cross-rider");
    const otherTenant = await createRestaurant("delivery-cross-rider-other");
    const branchId = await createBranch(tenant.restaurantId);
    const otherBranchId = await createBranch(otherTenant.restaurantId);
    const orderId = await createDeliveryOrder(tenant.restaurantId, tenant.ownerUserId, branchId);
    await service.setDetails({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, customerName: "Ali", customerPhone: "0300", addressLine1: "123 Main St" });
    const otherRider = await ridersService.create({ restaurantId: otherTenant.restaurantId, actorUserId: otherTenant.ownerUserId, branchId: otherBranchId, name: "Zain", phone: "0300" });

    await expect(
      service.assignRider({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, riderId: otherRider.id }),
    ).rejects.toThrow(NotFoundException);
  });

  it("updateStatus rejects when no delivery details have been set yet", async () => {
    const tenant = await createRestaurant("delivery-no-details");
    const branchId = await createBranch(tenant.restaurantId);
    const orderId = await createDeliveryOrder(tenant.restaurantId, tenant.ownerUserId, branchId);

    await expect(
      service.updateStatus({ restaurantId: tenant.restaurantId, actorUserId: tenant.ownerUserId, orderId, status: "delivered" }),
    ).rejects.toThrow(NotFoundException);
  });
});
