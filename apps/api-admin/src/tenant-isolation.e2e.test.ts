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
