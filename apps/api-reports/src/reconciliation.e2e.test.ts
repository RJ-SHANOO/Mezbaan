import { randomUUID } from "node:crypto";
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Pool } from "pg";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE, DEV_JWT_SECRET, PermissionGuard, PermissionsService, signAccessToken, TenantContextGuard } from "@mezbaan/nest-core";
import { AppModule } from "./app.module.js";

/** P2-26: the read side of the reconciliation review queue, over real HTTP —
 * proves route wiring, the reports.view permission gate and tenant
 * isolation, on top of reconciliation.service.test.ts's much more thorough
 * recomputation-math coverage. */
const SECRET = process.env.JWT_SECRET ?? DEV_JWT_SECRET;
const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5432/mezbaan";

let app: NestFastifyApplication;
let pool: Pool;
let db: Database;

beforeAll(async () => {
  pool = createPool(APP_DATABASE_URL);
  db = createDb(pool);

  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  app.useGlobalGuards(
    new TenantContextGuard({ secret: SECRET }),
    new PermissionGuard(new PermissionsService(app.get<Database>(DATABASE)), app.get(Reflector)),
  );
  await app.init();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

interface Tenant {
  restaurantId: string;
  branchId: string;
  accessToken: string;
}

async function createTenant(label: string): Promise<Tenant> {
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
    const branchRows = await tx.insert(schema.branches).values({ restaurantId: restaurant.id, name: "Main", timezone: "Asia/Karachi" }).returning({ id: schema.branches.id });
    const branch = branchRows[0];
    if (!branch) throw new Error("fixture: branch insert returned no row");

    const ownerRows = await tx
      .insert(schema.users)
      .values({ restaurantId: restaurant.id, roleId: role.id, email: `${label}@example.test`, passwordHash: "unused", displayName: label })
      .returning({ id: schema.users.id });
    const owner = ownerRows[0];
    if (!owner) throw new Error("fixture: user insert returned no row");

    const accessToken = signAccessToken(
      { sub: owner.id, restaurantId: restaurant.id, isSuperAdmin: false, roleKey: "owner", branchId: branch.id },
      { secret: SECRET, expiresInSeconds: 3600 },
    );

    return { restaurantId: restaurant.id, branchId: branch.id, accessToken };
  });
}

/** Direct insert, bypassing ReconciliationService — this file only proves the HTTP
 * surface, not the recomputation math (that's reconciliation.service.test.ts's job). */
async function seedFlag(tenant: Tenant): Promise<{ invoiceId: string; orderId: string }> {
  return withTenant(db, { restaurantId: tenant.restaurantId }, async (tx) => {
    const device = await tx
      .insert(schema.devices)
      .values({ restaurantId: tenant.restaurantId, branchId: tenant.branchId, label: "Till 1", deviceType: "pos_terminal" })
      .returning({ id: schema.devices.id });
    const order = await tx
      .insert(schema.orders)
      .values({ restaurantId: tenant.restaurantId, branchId: tenant.branchId, orderType: "takeaway", status: "closed", currency: "PKR", openedByUserId: (await tx.select({ id: schema.users.id }).from(schema.users).limit(1))[0]!.id })
      .returning({ id: schema.orders.id });
    const invoice = await tx
      .insert(schema.invoices)
      .values({
        restaurantId: tenant.restaurantId,
        branchId: tenant.branchId,
        orderId: order[0]!.id,
        deviceId: device[0]!.id,
        documentNumber: `TEST-${randomUUID()}`,
        subtotalMinor: 10_000n,
        serviceChargeMinor: 0n,
        taxMinor: 0n,
        totalMinor: 10_000n,
        currency: "PKR",
        pricingMode: "exclusive",
        taxRateBasisPoints: 0,
        appliedTaxRules: [],
        actorUserId: (await tx.select({ id: schema.users.id }).from(schema.users).limit(1))[0]!.id,
      })
      .returning({ id: schema.invoices.id });

    await tx.insert(schema.invoiceReconciliationFlags).values({
      restaurantId: tenant.restaurantId,
      branchId: tenant.branchId,
      invoiceId: invoice[0]!.id,
      orderId: order[0]!.id,
      storedSubtotalMinor: 10_000n,
      expectedSubtotalMinor: 12_000n,
      storedServiceChargeMinor: 0n,
      expectedServiceChargeMinor: 0n,
      storedTaxMinor: 0n,
      expectedTaxMinor: 0n,
      storedTotalMinor: 10_000n,
      expectedTotalMinor: 12_000n,
      mismatchedFields: "subtotal,total",
    });

    return { invoiceId: invoice[0]!.id, orderId: order[0]!.id };
  });
}

describe("reconciliation flags (api-reports, P2-26)", () => {
  it("rejects an unauthenticated request", async () => {
    const response = await app.inject({ method: "GET", url: "/reconciliation-flags" });
    expect(response.statusCode).toBe(401);
  });

  it("lists a tenant's own flags with the expected shape", async () => {
    const tenant = await createTenant("reconciliation-e2e");
    const { invoiceId } = await seedFlag(tenant);

    const response = await app.inject({ method: "GET", url: "/reconciliation-flags", headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(response.statusCode).toBe(200);
    const page = response.json<{ items: Array<{ invoiceId: string; storedSubtotalMinor: string; expectedSubtotalMinor: string; mismatchedFields: string[] }>; nextCursor: string | null }>();
    const flag = page.items.find((f) => f.invoiceId === invoiceId);
    expect(flag).toBeDefined();
    expect(flag!.storedSubtotalMinor).toBe("10000");
    expect(flag!.expectedSubtotalMinor).toBe("12000");
    expect(flag!.mismatchedFields).toEqual(["subtotal", "total"]);
  });

  it("never returns another tenant's flags", async () => {
    const tenantA = await createTenant("reconciliation-e2e-tenant-a");
    const tenantB = await createTenant("reconciliation-e2e-tenant-b");
    const { invoiceId } = await seedFlag(tenantA);

    const response = await app.inject({ method: "GET", url: "/reconciliation-flags", headers: { authorization: `Bearer ${tenantB.accessToken}` } });
    expect(response.statusCode).toBe(200);
    const page = response.json<{ items: Array<{ invoiceId: string }>; nextCursor: string | null }>();
    expect(page.items.map((f) => f.invoiceId)).not.toContain(invoiceId);
  });

  it("filters by branchId", async () => {
    const tenant = await createTenant("reconciliation-e2e-branch-filter");
    const { invoiceId } = await seedFlag(tenant);
    const otherBranch = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) =>
      tx.insert(schema.branches).values({ restaurantId: tenant.restaurantId, name: "Other", timezone: "Asia/Karachi" }).returning({ id: schema.branches.id }),
    );

    const matching = await app.inject({ method: "GET", url: `/reconciliation-flags?branchId=${tenant.branchId}`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(matching.json<{ items: Array<{ invoiceId: string }>; nextCursor: string | null }>().items.map((f) => f.invoiceId)).toContain(invoiceId);

    const nonMatching = await app.inject({ method: "GET", url: `/reconciliation-flags?branchId=${otherBranch[0]!.id}`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(nonMatching.json<{ items: Array<{ invoiceId: string }>; nextCursor: string | null }>().items.map((f) => f.invoiceId)).not.toContain(invoiceId);
  });
});
