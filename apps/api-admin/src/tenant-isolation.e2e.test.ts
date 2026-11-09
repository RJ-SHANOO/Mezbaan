import { randomUUID } from "node:crypto";
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Database } from "@mezbaan/db";
import {
  DATABASE,
  DEV_JWT_SECRET,
  PermissionGuard,
  PermissionsService,
  signAccessToken,
  TenantContextGuard,
  verifyAccessToken,
} from "@mezbaan/nest-core";
import { AppModule } from "./app.module.js";

/**
 * CLAUDE.md section 8: "Tenant isolation | Every endpoint and RLS policy; required
 * in CI" (P1-16). packages/db/src/rls.test.ts and packages/*'s service-level tests
 * already prove isolation at the RLS and service layer; this is the endpoint layer —
 * the real api-admin app, booted with the exact same guards main.ts registers, hit
 * over HTTP with no mocks. If TenantContextGuard or a controller ever regresses,
 * this is what catches a request from one restaurant actually reaching another's data.
 */

const SECRET = process.env.JWT_SECRET ?? DEV_JWT_SECRET;

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  app.useGlobalGuards(
    new TenantContextGuard({ secret: SECRET }),
    new PermissionGuard(new PermissionsService(app.get<Database>(DATABASE)), app.get(Reflector)),
  );
  await app.init();
});

afterAll(async () => {
  await app.close();
});

interface SignupHttpResponse {
  accessToken: string;
  refreshToken: string;
  restaurantId: string;
  branchId: string;
}

interface Tenant extends SignupHttpResponse {
  slug: string;
  ownerUserId: string;
}

async function signup(label: string): Promise<Tenant> {
  const slug = `${label}-${randomUUID()}`;
  const response = await app.inject({
    method: "POST",
    url: "/onboarding/signup",
    payload: {
      restaurantName: `${label} Restaurant`,
      slug,
      ownerEmail: `${label}@example.test`,
      ownerPassword: "a long enough password",
      ownerDisplayName: "The Owner",
      firstBranchName: "Main Branch",
      timezone: "Asia/Karachi",
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`signup fixture failed: ${response.statusCode} ${response.body}`);
  }
  const body = response.json<SignupHttpResponse>();
  const ownerUserId = verifyAccessToken(body.accessToken, SECRET).sub;
  return { ...body, slug, ownerUserId };
}

describe("tenant isolation — api-admin HTTP endpoints", () => {
  it("a restaurant can set and approve its own manager PIN (positive control)", async () => {
    const tenant = await signup("iso-self-approve");

    const setPin = await app.inject({
      method: "POST",
      url: "/manager-pin",
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { pin: "1234" },
    });
    expect(setPin.statusCode).toBe(201);

    const approve = await app.inject({
      method: "POST",
      url: "/manager-pin/approve",
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { managerUserId: tenant.ownerUserId, pin: "1234", action: "void" },
    });
    expect(approve.statusCode).toBe(201);
    expect(approve.json()).toEqual({ approved: true });
  });

  it("one restaurant's token can never approve naming another restaurant's owner, even with that owner's real PIN", async () => {
    const tenantA = await signup("iso-attack-a");
    const tenantB = await signup("iso-attack-b");

    await app.inject({
      method: "POST",
      url: "/manager-pin",
      headers: { authorization: `Bearer ${tenantB.accessToken}` },
      payload: { pin: "4321" },
    });

    // Tenant A's own (valid) token, but pointing at tenant B's owner id and B's real
    // PIN. If this ever returns 201, tenant isolation on the approval path is broken.
    const crossTenantApprove = await app.inject({
      method: "POST",
      url: "/manager-pin/approve",
      headers: { authorization: `Bearer ${tenantA.accessToken}` },
      payload: { managerUserId: tenantB.ownerUserId, pin: "4321", action: "void" },
    });
    expect(crossTenantApprove.statusCode).toBe(403);
  });

  it("signup rejects a slug that's already registered to another restaurant", async () => {
    const tenant = await signup("iso-dup-slug");

    const response = await app.inject({
      method: "POST",
      url: "/onboarding/signup",
      payload: {
        restaurantName: "A Different Name",
        slug: tenant.slug,
        ownerEmail: `iso-dup-slug-2-${randomUUID()}@example.test`,
        ownerPassword: "a long enough password",
        ownerDisplayName: "A Different Owner",
        firstBranchName: "A Different Branch",
        timezone: "Asia/Karachi",
      },
    });
    expect(response.statusCode).toBe(409);
  });

  it("a restaurant can create, list, and update its own branch (positive control)", async () => {
    const tenant = await signup("iso-branch-ok");

    const create = await app.inject({
      method: "POST",
      url: "/branches",
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { name: "Second Branch", timezone: "Asia/Karachi" },
    });
    expect(create.statusCode).toBe(201);
    const branch = create.json<{ id: string }>();

    const list = await app.inject({ method: "GET", url: "/branches", headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(list.statusCode).toBe(200);
    expect(list.json<Array<{ id: string }>>().map((b) => b.id)).toContain(branch.id);

    const update = await app.inject({
      method: "PATCH",
      url: `/branches/${branch.id}`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { status: "inactive" },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json<{ status: string }>().status).toBe("inactive");
  });

  it("one restaurant's token can never see or update another restaurant's branch", async () => {
    const tenantA = await signup("iso-branch-attack-a");
    const tenantB = await signup("iso-branch-attack-b");

    const create = await app.inject({
      method: "POST",
      url: "/branches",
      headers: { authorization: `Bearer ${tenantB.accessToken}` },
      payload: { name: "B's Branch", timezone: "Asia/Karachi" },
    });
    const branch = create.json<{ id: string }>();

    const list = await app.inject({ method: "GET", url: "/branches", headers: { authorization: `Bearer ${tenantA.accessToken}` } });
    expect(list.json<Array<{ id: string }>>().map((b) => b.id)).not.toContain(branch.id);

    const update = await app.inject({
      method: "PATCH",
      url: `/branches/${branch.id}`,
      headers: { authorization: `Bearer ${tenantA.accessToken}` },
      payload: { name: "Hijacked" },
    });
    expect(update.statusCode).toBe(404);
  });

  it("a restaurant can invite a user, and the invitee can accept and then log in (positive control)", async () => {
    const tenant = await signup("iso-invite-ok");
    const email = `iso-invite-ok-${randomUUID()}@example.test`;

    const invite = await app.inject({
      method: "POST",
      url: "/users/invite",
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { email, roleKey: "cashier" },
    });
    expect(invite.statusCode).toBe(201);
    const { inviteToken } = invite.json<{ inviteToken: string }>();

    const accept = await app.inject({
      method: "POST",
      url: "/users/invite/accept",
      payload: { inviteToken, displayName: "New Cashier", password: "a long enough password" },
    });
    expect(accept.statusCode).toBe(201);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { restaurantSlug: tenant.slug, email, password: "a long enough password" },
    });
    expect(login.statusCode).toBe(201);
  });

  it("an invited cashier (no settings.manage) can't manage branches or invite other staff", async () => {
    const tenant = await signup("iso-invite-permission");
    const email = `iso-invite-permission-${randomUUID()}@example.test`;

    const invite = await app.inject({
      method: "POST",
      url: "/users/invite",
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { email, roleKey: "cashier" },
    });
    const { inviteToken } = invite.json<{ inviteToken: string }>();
    await app.inject({
      method: "POST",
      url: "/users/invite/accept",
      payload: { inviteToken, displayName: "Cashier", password: "a long enough password" },
    });
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { restaurantSlug: tenant.slug, email, password: "a long enough password" } });
    const { accessToken: cashierToken } = login.json<{ accessToken: string }>();

    const createBranch = await app.inject({
      method: "POST",
      url: "/branches",
      headers: { authorization: `Bearer ${cashierToken}` },
      payload: { name: "Cashier's Branch", timezone: "Asia/Karachi" },
    });
    expect(createBranch.statusCode).toBe(403);

    const inviteSomeoneElse = await app.inject({
      method: "POST",
      url: "/users/invite",
      headers: { authorization: `Bearer ${cashierToken}` },
      payload: { email: `someone-else-${randomUUID()}@example.test`, roleKey: "cashier" },
    });
    expect(inviteSomeoneElse.statusCode).toBe(403);

    const createDevice = await app.inject({
      method: "POST",
      url: "/devices",
      headers: { authorization: `Bearer ${cashierToken}` },
      payload: { label: "Cashier's Terminal", deviceType: "pos_terminal", branchId: tenant.branchId },
    });
    expect(createDevice.statusCode).toBe(403);
  });

  it("a restaurant can create a device, generate a pairing code for it, and revoke it (positive control)", async () => {
    const tenant = await signup("iso-device-ok");

    const create = await app.inject({
      method: "POST",
      url: "/devices",
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { label: "Front Counter", deviceType: "pos_terminal", branchId: tenant.branchId },
    });
    expect(create.statusCode).toBe(201);
    const device = create.json<{ id: string; status: string }>();
    expect(device.status).toBe("active");

    const list = await app.inject({ method: "GET", url: "/devices", headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(list.json<Array<{ id: string }>>().map((d) => d.id)).toContain(device.id);

    const pairingCode = await app.inject({
      method: "POST",
      url: `/devices/${device.id}/pairing-code`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
    });
    expect(pairingCode.statusCode).toBe(201);
    expect(pairingCode.json<{ pairingCode: string }>().pairingCode).toBeTruthy();

    const revoke = await app.inject({
      method: "POST",
      url: `/devices/${device.id}/revoke`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
    });
    expect(revoke.statusCode).toBe(201);
    expect(revoke.json<{ status: string }>().status).toBe("revoked");
  });

  it("one restaurant's token can never see, pair, or revoke another restaurant's device", async () => {
    const tenantA = await signup("iso-device-attack-a");
    const tenantB = await signup("iso-device-attack-b");

    const create = await app.inject({
      method: "POST",
      url: "/devices",
      headers: { authorization: `Bearer ${tenantB.accessToken}` },
      payload: { label: "B's Terminal", deviceType: "pos_terminal", branchId: tenantB.branchId },
    });
    const device = create.json<{ id: string }>();

    const list = await app.inject({ method: "GET", url: "/devices", headers: { authorization: `Bearer ${tenantA.accessToken}` } });
    expect(list.json<Array<{ id: string }>>().map((d) => d.id)).not.toContain(device.id);

    const pairingCode = await app.inject({
      method: "POST",
      url: `/devices/${device.id}/pairing-code`,
      headers: { authorization: `Bearer ${tenantA.accessToken}` },
    });
    expect(pairingCode.statusCode).toBe(404);

    const revoke = await app.inject({
      method: "POST",
      url: `/devices/${device.id}/revoke`,
      headers: { authorization: `Bearer ${tenantA.accessToken}` },
    });
    expect(revoke.statusCode).toBe(404);
  });

  function superAdminToken(): string {
    return signAccessToken(
      { sub: randomUUID(), restaurantId: null, isSuperAdmin: true, roleKey: "super_admin", branchId: null },
      { secret: SECRET },
    );
  }

  it("a super admin can set a restaurant's feature flag, and the restaurant sees it on its own read (positive control)", async () => {
    const tenant = await signup("iso-flags-ok");
    const adminToken = superAdminToken();

    const setFlag = await app.inject({
      method: "PUT",
      url: `/restaurants/${tenant.restaurantId}/feature-flags/inventory`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: false },
    });
    expect(setFlag.statusCode).toBe(200);
    expect(setFlag.json<{ moduleKey: string; enabled: boolean }>()).toMatchObject({ moduleKey: "inventory", enabled: false });

    const adminList = await app.inject({
      method: "GET",
      url: `/restaurants/${tenant.restaurantId}/feature-flags`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(adminList.statusCode).toBe(200);
    expect(adminList.json<Array<{ moduleKey: string }>>().map((f) => f.moduleKey)).toContain("inventory");

    const ownList = await app.inject({ method: "GET", url: "/feature-flags", headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(ownList.statusCode).toBe(200);
    expect(ownList.json<Array<{ moduleKey: string; enabled: boolean }>>()).toContainEqual(
      expect.objectContaining({ moduleKey: "inventory", enabled: false }),
    );
  });

  it("a restaurant's own token can never set or cross-tenant-read feature flags — super-admin only", async () => {
    const tenantA = await signup("iso-flags-attack-a");
    const tenantB = await signup("iso-flags-attack-b");

    const setOwn = await app.inject({
      method: "PUT",
      url: `/restaurants/${tenantA.restaurantId}/feature-flags/inventory`,
      headers: { authorization: `Bearer ${tenantA.accessToken}` },
      payload: { enabled: false },
    });
    expect(setOwn.statusCode).toBe(403);

    const readOther = await app.inject({
      method: "GET",
      url: `/restaurants/${tenantB.restaurantId}/feature-flags`,
      headers: { authorization: `Bearer ${tenantA.accessToken}` },
    });
    expect(readOther.statusCode).toBe(403);

    const setOther = await app.inject({
      method: "PUT",
      url: `/restaurants/${tenantB.restaurantId}/feature-flags/inventory`,
      headers: { authorization: `Bearer ${tenantA.accessToken}` },
      payload: { enabled: false },
    });
    expect(setOther.statusCode).toBe(403);
  });

  it("one restaurant's own-flags read never shows another restaurant's flag that a super admin set", async () => {
    const tenantA = await signup("iso-flags-read-a");
    const tenantB = await signup("iso-flags-read-b");
    const adminToken = superAdminToken();

    await app.inject({
      method: "PUT",
      url: `/restaurants/${tenantB.restaurantId}/feature-flags/reports`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: false },
    });

    const ownListA = await app.inject({ method: "GET", url: "/feature-flags", headers: { authorization: `Bearer ${tenantA.accessToken}` } });
    expect(ownListA.json<Array<{ moduleKey: string }>>().map((f) => f.moduleKey)).not.toContain("reports");
  });

  it("a restaurant can create a category, a product under it, and set branch availability (positive control)", async () => {
    const tenant = await signup("iso-catalog-ok");

    const category = await app.inject({
      method: "POST",
      url: "/categories",
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { name: "Burgers" },
    });
    expect(category.statusCode).toBe(201);
    const categoryId = category.json<{ id: string }>().id;

    const product = await app.inject({
      method: "POST",
      url: "/products",
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { categoryId, name: "Cheeseburger", sku: "BRG-001" },
    });
    expect(product.statusCode).toBe(201);
    const productId = product.json<{ id: string }>().id;

    const availability = await app.inject({
      method: "PUT",
      url: `/products/${productId}/availability`,
      headers: { authorization: `Bearer ${tenant.accessToken}` },
      payload: { branchId: tenant.branchId, available: false },
    });
    expect(availability.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/products", headers: { authorization: `Bearer ${tenant.accessToken}` } });
    expect(list.json<Array<{ id: string }>>().map((p) => p.id)).toContain(productId);
  });

  it("one restaurant's token can never see, update, or set availability on another restaurant's category/product", async () => {
    const tenantA = await signup("iso-catalog-a");
    const tenantB = await signup("iso-catalog-b");

    const category = await app.inject({
      method: "POST",
      url: "/categories",
      headers: { authorization: `Bearer ${tenantA.accessToken}` },
      payload: { name: "A's Category" },
    });
    const categoryId = category.json<{ id: string }>().id;
    const product = await app.inject({
      method: "POST",
      url: "/products",
      headers: { authorization: `Bearer ${tenantA.accessToken}` },
      payload: { categoryId, name: "A's Product" },
    });
    const productId = product.json<{ id: string }>().id;

    const listByB = await app.inject({ method: "GET", url: "/products", headers: { authorization: `Bearer ${tenantB.accessToken}` } });
    expect(listByB.json<Array<{ id: string }>>()).toEqual([]);

    const updateByB = await app.inject({
      method: "PATCH",
      url: `/products/${productId}`,
      headers: { authorization: `Bearer ${tenantB.accessToken}` },
      payload: { name: "Hijacked" },
    });
    expect(updateByB.statusCode).toBe(404);

    const categoryUpdateByB = await app.inject({
      method: "PATCH",
      url: `/categories/${categoryId}`,
      headers: { authorization: `Bearer ${tenantB.accessToken}` },
      payload: { name: "Hijacked" },
    });
    expect(categoryUpdateByB.statusCode).toBe(404);

    const availabilityByB = await app.inject({
      method: "PUT",
      url: `/products/${productId}/availability`,
      headers: { authorization: `Bearer ${tenantB.accessToken}` },
      payload: { branchId: tenantB.branchId, available: false },
    });
    expect(availabilityByB.statusCode).toBe(404);
  });

  it("an invalid or missing token is rejected by every protected route the same way", async () => {
    const noToken = await app.inject({ method: "POST", url: "/manager-pin", payload: { pin: "1234" } });
    expect(noToken.statusCode).toBe(401);

    const garbageToken = await app.inject({
      method: "POST",
      url: "/manager-pin",
      headers: { authorization: "Bearer not-a-real-token" },
      payload: { pin: "1234" },
    });
    expect(garbageToken.statusCode).toBe(401);
  });
});
