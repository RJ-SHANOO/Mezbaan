import { randomUUID } from "node:crypto";
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Pool } from "pg";
import { createDb, createPool, schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE, DEV_JWT_SECRET, PermissionGuard, PermissionsService, signAccessToken, TenantContextGuard } from "@mezbaan/nest-core";
import { AppModule } from "./app.module.js";

/** P2-25: charging and repaying a credit customer's account at the POS —
 * creation/credit-limit management is api-admin's job (credit.manage), this
 * app only exercises the pos.sell-gated sale-time actions. */
const SECRET = process.env.JWT_SECRET ?? DEV_JWT_SECRET;
const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ?? "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5433/mezbaan";

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
  ownerUserId: string;
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

    const accessToken = signAccessToken(
      { sub: owner.id, restaurantId: restaurant.id, isSuperAdmin: false, roleKey: "owner", branchId: branch.id },
      { secret: SECRET, expiresInSeconds: 3600 },
    );

    return { restaurantId: restaurant.id, branchId: branch.id, ownerUserId: owner.id, accessToken };
  });
}

async function createCreditCustomer(tenant: Tenant, creditLimitMinor: string): Promise<string> {
  const rows = await withTenant(db, { restaurantId: tenant.restaurantId }, (tx) =>
    tx
      .insert(schema.creditCustomers)
      .values({ restaurantId: tenant.restaurantId, name: "Acme Corp", creditLimitMinor: BigInt(creditLimitMinor), currency: "PKR" })
      .returning({ id: schema.creditCustomers.id }),
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("fixture: credit customer insert returned no row");
  return id;
}

describe("credit accounts — charges and repayments (api-pos, P2-25)", () => {
  it("charges within the limit, then a repayment reduces the balance", async () => {
    const tenant = await createTenant("credit-e2e-ok");
    const customerId = await createCreditCustomer(tenant, "10000");

    const charge = await app.inject({ method: "POST", url: `/credit-customers/${customerId}/charges`, headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { amountMinor: "4000" } });
    expect(charge.statusCode).toBe(201);

    const repay = await app.inject({ method: "POST", url: `/credit-customers/${customerId}/repayments`, headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { amountMinor: "1500" } });
    expect(repay.statusCode).toBe(201);

    const balance = await app.inject({ method: "GET", url: `/credit-customers/${customerId}/balance`, headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(balance.json<{ balanceMinor: string }>().balanceMinor).toBe("2500");
  });

  it("rejects a charge that would exceed the credit limit", async () => {
    const tenant = await createTenant("credit-e2e-exceeds");
    const customerId = await createCreditCustomer(tenant, "5000");

    const charge = await app.inject({ method: "POST", url: `/credit-customers/${customerId}/charges`, headers: { authorization: `Bearer ${tenant.accessToken}` }, payload: { amountMinor: "6000" } });
    expect(charge.statusCode).toBe(400);
  });
});
