import { AsyncLocalStorage } from "node:async_hooks";
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import jwt from "jsonwebtoken";
import type { TenantContext } from "@mezbaan/db";

/** Shared across every app's main.ts fallback so a token issued by one verifies
 * correctly against another in local dev. Always override with a real JWT_SECRET
 * outside local dev. */
export const DEV_JWT_SECRET = "dev-only-insecure-jwt-secret-change-me";

export interface AccessTokenClaims {
  sub: string; // user id
  restaurantId: string | null; // null only for a platform-level super-admin token
  isSuperAdmin: boolean;
  roleKey: string;
  branchId: string | null;
}

export interface RequestTenantContext extends TenantContext {
  userId: string | null;
  roleKey: string | null;
  branchId: string | null;
  /** false for an anonymous request (no Authorization header at all) — a given route
   * requiring auth is a different guard's job (P1-12), not this one's. */
  authenticated: boolean;
}

const ANONYMOUS_CONTEXT: RequestTenantContext = {
  restaurantId: null,
  isSuperAdmin: false,
  userId: null,
  roleKey: null,
  branchId: null,
  authenticated: false,
};

const tenantContextStorage = new AsyncLocalStorage<RequestTenantContext>();

/**
 * Reads the current request's tenant context. Only meaningful downstream of
 * TenantContextGuard; calling it outside a request (or before the guard has run)
 * returns the anonymous context rather than throwing.
 */
export function getTenantContext(): RequestTenantContext {
  return tenantContextStorage.getStore() ?? ANONYMOUS_CONTEXT;
}

export interface SignAccessTokenOptions {
  secret: string;
  expiresInSeconds?: number;
}

export function signAccessToken(claims: AccessTokenClaims, options: SignAccessTokenOptions): string {
  return jwt.sign(claims, options.secret, { expiresIn: options.expiresInSeconds ?? 60 * 60 });
}

export function verifyAccessToken(token: string, secret: string): AccessTokenClaims {
  const decoded = jwt.verify(token, secret);
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("verifyAccessToken: token payload is not an object");
  }
  const claims = decoded as Record<string, unknown>;
  if (
    typeof claims["sub"] !== "string" ||
    typeof claims["isSuperAdmin"] !== "boolean" ||
    typeof claims["roleKey"] !== "string"
  ) {
    throw new Error("verifyAccessToken: token is missing required claims");
  }
  const restaurantId = claims["restaurantId"];
  const branchId = claims["branchId"];
  return {
    sub: claims["sub"],
    restaurantId: typeof restaurantId === "string" ? restaurantId : null,
    isSuperAdmin: claims["isSuperAdmin"],
    roleKey: claims["roleKey"],
    branchId: typeof branchId === "string" ? branchId : null,
  };
}

const RESTAURANT_ID_KEYS = ["restaurantId", "restaurant_id"];

function findConflictingRestaurantId(source: unknown, tokenRestaurantId: string | null): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const record = source as Record<string, unknown>;
  for (const key of RESTAURANT_ID_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value !== tokenRestaurantId) {
      return value;
    }
  }
  return undefined;
}

interface TenantAwareRequest {
  headers: Record<string, unknown>;
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

export interface TenantContextGuardOptions {
  secret: string;
}

/**
 * Global guard — the only place a request's tenant context gets established, and the
 * only place restaurant_id is read off the token (rule 1: never from body/query/header).
 *
 * No Authorization header is not an error: the request proceeds with the anonymous
 * context, since whether a given route requires auth at all is a different guard's
 * job (P1-12). An invalid/expired token, or a body/query/param that names a
 * restaurant_id other than the token's, is always rejected — the second case is
 * exactly rule 1's "reject any conflict."
 *
 * A super-admin token is the one exception: its own restaurantId claim is always
 * null (it isn't scoped to any tenant), so "reject anything that differs from the
 * token's restaurantId" would reject every restaurantId a super-admin route ever
 * legitimately names (P1-23's cross-restaurant flag endpoints, P3-39's Super Admin
 * screens). There's no spoofing risk to guard against here — a super-admin token
 * doesn't claim to BE a tenant, so there's nothing for a request body/param to
 * disagree with; the explicit restaurantId it names is still enforced for real by
 * RLS/withTenant at the data layer, same as everywhere else.
 */
@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(private readonly options: TenantContextGuardOptions) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<TenantAwareRequest>();
    const authorization = request.headers["authorization"];
    const header = typeof authorization === "string" ? authorization : undefined;

    if (header === undefined) {
      tenantContextStorage.enterWith(ANONYMOUS_CONTEXT);
      return true;
    }

    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) {
      throw new UnauthorizedException("Authorization header must be a Bearer token");
    }

    let claims: AccessTokenClaims;
    try {
      claims = verifyAccessToken(token, this.options.secret);
    } catch {
      throw new UnauthorizedException("Invalid or expired access token");
    }

    if (!claims.isSuperAdmin) {
      for (const source of [request.body, request.query, request.params]) {
        if (findConflictingRestaurantId(source, claims.restaurantId) !== undefined) {
          throw new ForbiddenException("restaurant_id in the request does not match the authenticated tenant");
        }
      }
    }

    tenantContextStorage.enterWith({
      restaurantId: claims.restaurantId,
      isSuperAdmin: claims.isSuperAdmin,
      userId: claims.sub,
      roleKey: claims.roleKey,
      branchId: claims.branchId,
      authenticated: true,
    });
    return true;
  }
}
