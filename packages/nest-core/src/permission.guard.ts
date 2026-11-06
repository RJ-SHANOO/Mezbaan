import { CanActivate, ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { BRANCH_MATCH_KEY, PERMISSION_KEY } from "./permission.decorator.js";
import type { PermissionsService } from "./permissions.service.js";
import { getTenantContext } from "./tenant-context.js";

const BRANCH_ID_KEYS = ["branchId", "branch_id"];

function findConflictingBranchId(source: unknown, tokenBranchId: string): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const record = source as Record<string, unknown>;
  for (const key of BRANCH_ID_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value !== tokenBranchId) {
      return value;
    }
  }
  return undefined;
}

interface BranchAwareRequest {
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

/**
 * Opt-in, like TenantContextGuard: a route with neither @RequirePermission nor
 * @RequireBranchMatch is untouched by this guard. Super-admin sessions bypass both
 * checks — same reasoning as the RLS policies bypassing for super-admin (P1-09).
 */
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly permissionsService: PermissionsService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermission = this.reflector.getAllAndOverride<string | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const requireBranchMatch = this.reflector.getAllAndOverride<boolean | undefined>(BRANCH_MATCH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredPermission && !requireBranchMatch) {
      return true;
    }

    const tenant = getTenantContext();
    if (!tenant.authenticated) {
      throw new UnauthorizedException("Authentication required");
    }
    if (tenant.isSuperAdmin) {
      return true;
    }

    if (requiredPermission) {
      if (!tenant.roleKey || !(await this.permissionsService.hasPermission(tenant.roleKey, requiredPermission))) {
        throw new ForbiddenException(`Missing permission: ${requiredPermission}`);
      }
    }

    if (requireBranchMatch && tenant.branchId !== null) {
      const request = context.switchToHttp().getRequest<BranchAwareRequest>();
      for (const source of [request.body, request.query, request.params]) {
        if (findConflictingBranchId(source, tenant.branchId) !== undefined) {
          throw new ForbiddenException("branch_id in the request does not match your assigned branch");
        }
      }
    }

    return true;
  }
}
