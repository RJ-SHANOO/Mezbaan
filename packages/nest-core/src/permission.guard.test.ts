import { describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { BRANCH_MATCH_KEY, PERMISSION_KEY } from "./permission.decorator.js";
import { PermissionGuard } from "./permission.guard.js";
import type { PermissionsService } from "./permissions.service.js";
import { signAccessToken, TenantContextGuard, type AccessTokenClaims } from "./tenant-context.js";

const SECRET = "test-secret";
const tenantGuard = new TenantContextGuard({ secret: SECRET });

interface FakeRequest {
  headers?: Record<string, unknown>;
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

function fakeContext(request: FakeRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function establishContext(claims: AccessTokenClaims): void {
  const token = signAccessToken(claims, { secret: SECRET });
  tenantGuard.canActivate(fakeContext({ headers: { authorization: `Bearer ${token}` } }));
}

function establishAnonymousContext(): void {
  tenantGuard.canActivate(fakeContext({ headers: {} }));
}

function mockReflector(values: { permission?: string; branchMatch?: boolean }): Reflector {
  return {
    getAllAndOverride: (key: string) =>
      key === PERMISSION_KEY ? values.permission : key === BRANCH_MATCH_KEY ? values.branchMatch : undefined,
  } as unknown as Reflector;
}

function mockPermissionsService(allowed: boolean): PermissionsService {
  return { hasPermission: vi.fn().mockResolvedValue(allowed) } as unknown as PermissionsService;
}

const baseClaims: AccessTokenClaims = {
  sub: "user-1",
  restaurantId: "11111111-1111-1111-1111-111111111111",
  isSuperAdmin: false,
  roleKey: "cashier",
  branchId: "22222222-2222-2222-2222-222222222222",
};

describe("PermissionGuard", () => {
  it("allows a route with neither decorator, regardless of auth state", async () => {
    establishAnonymousContext();
    const guard = new PermissionGuard(mockPermissionsService(false), mockReflector({}));
    await expect(guard.canActivate(fakeContext({ headers: {} }))).resolves.toBe(true);
  });

  it("rejects an unauthenticated request on a permission-guarded route", async () => {
    establishAnonymousContext();
    const guard = new PermissionGuard(mockPermissionsService(true), mockReflector({ permission: "pos.sell" }));
    await expect(guard.canActivate(fakeContext({ headers: {} }))).rejects.toThrow();
  });

  it("allows a super-admin regardless of the permission check result", async () => {
    establishContext({ ...baseClaims, isSuperAdmin: true });
    const guard = new PermissionGuard(mockPermissionsService(false), mockReflector({ permission: "pos.sell" }));
    await expect(guard.canActivate(fakeContext({ headers: {} }))).resolves.toBe(true);
  });

  it("allows when the role has the required permission", async () => {
    establishContext(baseClaims);
    const guard = new PermissionGuard(mockPermissionsService(true), mockReflector({ permission: "pos.sell" }));
    await expect(guard.canActivate(fakeContext({ headers: {} }))).resolves.toBe(true);
  });

  it("rejects when the role lacks the required permission", async () => {
    establishContext(baseClaims);
    const guard = new PermissionGuard(mockPermissionsService(false), mockReflector({ permission: "pos.sell" }));
    await expect(guard.canActivate(fakeContext({ headers: {} }))).rejects.toThrow();
  });

  it("branch match: allows when the request's branchId matches the token's", async () => {
    establishContext(baseClaims);
    const guard = new PermissionGuard(mockPermissionsService(true), mockReflector({ branchMatch: true }));
    await expect(
      guard.canActivate(fakeContext({ headers: {}, body: { branchId: baseClaims.branchId } })),
    ).resolves.toBe(true);
  });

  it("branch match: rejects when the request's branchId conflicts with the token's", async () => {
    establishContext(baseClaims);
    const guard = new PermissionGuard(mockPermissionsService(true), mockReflector({ branchMatch: true }));
    await expect(
      guard.canActivate(fakeContext({ headers: {}, query: { branchId: "99999999-9999-9999-9999-999999999999" } })),
    ).rejects.toThrow();
  });

  it("branch match: a null token branchId (e.g. an Owner) is never restricted", async () => {
    establishContext({ ...baseClaims, branchId: null });
    const guard = new PermissionGuard(mockPermissionsService(true), mockReflector({ branchMatch: true }));
    await expect(
      guard.canActivate(fakeContext({ headers: {}, params: { branchId: "99999999-9999-9999-9999-999999999999" } })),
    ).resolves.toBe(true);
  });
});
