import { SetMetadata } from "@nestjs/common";

export const PERMISSION_KEY = "mezbaan:requiredPermission";
export const BRANCH_MATCH_KEY = "mezbaan:requireBranchMatch";

/** Marks a route as needing a specific permission (checked against role_permissions
 * for the caller's role). Routes without this decorator are untouched by
 * PermissionGuard — it's opt-in, same as TenantContextGuard is lenient by default. */
export const RequirePermission = (permissionKey: string): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSION_KEY, permissionKey);

/** Marks a route as branch-scoped: a caller whose token has a branchId can only act
 * on that branch — any branchId/branch_id found in body/query/params that disagrees
 * is rejected, the same way TenantContextGuard rejects a conflicting restaurant_id.
 * A caller with no branchId on their token (e.g. an Owner) isn't restricted. */
export const RequireBranchMatch = (): MethodDecorator & ClassDecorator => SetMetadata(BRANCH_MATCH_KEY, true);
