import { Body, Controller, ForbiddenException, Get, Param, Put, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { ModuleKeySchema, SetFeatureFlagSchema, type FeatureFlag } from "@mezbaan/contracts";
import { FeatureFlagsService, type FeatureFlagRecord } from "./feature-flags.service.js";
import { getTenantContext } from "./tenant-context.js";
import { parseOrBadRequest } from "./validation.js";

const RestaurantIdParamSchema = z.object({ restaurantId: z.string().uuid() });
const RestaurantAndModuleParamSchema = z.object({ restaurantId: z.string().uuid(), moduleKey: ModuleKeySchema });

function toFeatureFlagResponse(flag: FeatureFlagRecord): FeatureFlag {
  return {
    id: flag.id,
    restaurantId: flag.restaurantId,
    moduleKey: flag.moduleKey,
    enabled: flag.enabled,
    updatedByUserId: flag.updatedByUserId,
    createdAt: flag.createdAt.toISOString(),
    updatedAt: flag.updatedAt.toISOString(),
  };
}

@Controller()
export class FeatureFlagsController {
  constructor(private readonly featureFlagsService: FeatureFlagsService) {}

  /** Any authenticated member of a restaurant can see their own flags — transparency,
   * and the eventual read path for the desktop/POS side once sync exists (P1-24-26). */
  @Get("feature-flags")
  async listMine(): Promise<FeatureFlag[]> {
    const tenant = requireTenant();
    const flags = await this.featureFlagsService.listForRestaurant(tenant.restaurantId);
    return flags.map(toFeatureFlagResponse);
  }

  @Get("restaurants/:restaurantId/feature-flags")
  async listForRestaurant(@Param() params: unknown): Promise<FeatureFlag[]> {
    requireSuperAdmin();
    const { restaurantId } = parseOrBadRequest(RestaurantIdParamSchema, params);
    const flags = await this.featureFlagsService.listForRestaurantAsSuperAdmin(restaurantId);
    return flags.map(toFeatureFlagResponse);
  }

  @Put("restaurants/:restaurantId/feature-flags/:moduleKey")
  async setFlag(@Param() params: unknown, @Body() body: unknown): Promise<FeatureFlag> {
    const actor = requireSuperAdmin();
    const { restaurantId, moduleKey } = parseOrBadRequest(RestaurantAndModuleParamSchema, params);
    const { enabled } = parseOrBadRequest(SetFeatureFlagSchema, body);
    const flag = await this.featureFlagsService.setFlag({ restaurantId, moduleKey, enabled, actorUserId: actor.userId });
    return toFeatureFlagResponse(flag);
  }
}

function requireTenant(): { restaurantId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId };
}

/** No @RequirePermission/role-seed for this: a super-admin token already bypasses
 * PermissionGuard entirely, and these routes must never be reachable by anyone else —
 * including an Owner, who (unlike settings.manage-style permissions) gets no say over
 * another restaurant's, or even their own restaurant's, remote kill switches. */
function requireSuperAdmin(): { userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  if (!tenant.isSuperAdmin) {
    throw new ForbiddenException("Super admin access required");
  }
  return { userId: tenant.userId };
}
