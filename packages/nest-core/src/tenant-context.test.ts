import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "@nestjs/common";
import jwt from "jsonwebtoken";
import {
  getTenantContext,
  signAccessToken,
  TenantContextGuard,
  verifyAccessToken,
  type AccessTokenClaims,
} from "./tenant-context.js";

const SECRET = "test-secret";

function fakeContext(request: {
  headers: Record<string, unknown>;
  body?: unknown;
  query?: unknown;
  params?: unknown;
}): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const claims: AccessTokenClaims = {
  sub: "user-1",
  restaurantId: "11111111-1111-1111-1111-111111111111",
  isSuperAdmin: false,
  roleKey: "cashier",
  branchId: "22222222-2222-2222-2222-222222222222",
};

describe("signAccessToken() / verifyAccessToken()", () => {
  it("round-trips the claims", () => {
    const token = signAccessToken(claims, { secret: SECRET });
    expect(verifyAccessToken(token, SECRET)).toEqual(claims);
  });

  it("rejects a token signed with a different secret", () => {
    const token = signAccessToken(claims, { secret: SECRET });
    expect(() => verifyAccessToken(token, "wrong-secret")).toThrow();
  });

  it("rejects an expired token", () => {
    const token = signAccessToken(claims, { secret: SECRET, expiresInSeconds: -1 });
    expect(() => verifyAccessToken(token, SECRET)).toThrow();
  });

  it("rejects a token missing required claims", () => {
    // Signed directly (bypassing signAccessToken) to omit a required claim.
    const token = jwt.sign({ sub: "user-1" }, SECRET);
    expect(() => verifyAccessToken(token, SECRET)).toThrow();
  });
});

describe("TenantContextGuard", () => {
  const guard = new TenantContextGuard({ secret: SECRET });

  it("allows an anonymous request through with the anonymous context", () => {
    const allowed = guard.canActivate(fakeContext({ headers: {} }));
    expect(allowed).toBe(true);
    expect(getTenantContext()).toEqual({
      restaurantId: null,
      isSuperAdmin: false,
      userId: null,
      roleKey: null,
      branchId: null,
      authenticated: false,
    });
  });

  it("establishes the tenant context from a valid Bearer token", () => {
    const token = signAccessToken(claims, { secret: SECRET });
    const allowed = guard.canActivate(fakeContext({ headers: { authorization: `Bearer ${token}` } }));
    expect(allowed).toBe(true);
    expect(getTenantContext()).toEqual({
      restaurantId: claims.restaurantId,
      isSuperAdmin: claims.isSuperAdmin,
      userId: claims.sub,
      roleKey: claims.roleKey,
      branchId: claims.branchId,
      authenticated: true,
    });
  });

  it("rejects a header that isn't a Bearer token", () => {
    expect(() => guard.canActivate(fakeContext({ headers: { authorization: "Basic abc123" } }))).toThrow();
  });

  it("rejects an invalid token", () => {
    expect(() =>
      guard.canActivate(fakeContext({ headers: { authorization: "Bearer not-a-real-token" } })),
    ).toThrow();
  });

  it("allows a request body that names the SAME restaurant_id as the token", () => {
    const token = signAccessToken(claims, { secret: SECRET });
    const allowed = guard.canActivate(
      fakeContext({
        headers: { authorization: `Bearer ${token}` },
        body: { restaurantId: claims.restaurantId, name: "whatever" },
      }),
    );
    expect(allowed).toBe(true);
  });

  it("rejects a request body naming a different restaurant_id than the token — rule 1", () => {
    const token = signAccessToken(claims, { secret: SECRET });
    expect(() =>
      guard.canActivate(
        fakeContext({
          headers: { authorization: `Bearer ${token}` },
          body: { restaurantId: "99999999-9999-9999-9999-999999999999" },
        }),
      ),
    ).toThrow();
  });

  it("rejects a conflicting restaurant_id in the query string too", () => {
    const token = signAccessToken(claims, { secret: SECRET });
    expect(() =>
      guard.canActivate(
        fakeContext({
          headers: { authorization: `Bearer ${token}` },
          query: { restaurant_id: "99999999-9999-9999-9999-999999999999" },
        }),
      ),
    ).toThrow();
  });
});
