import { Body, Controller, Get, Put, UnauthorizedException } from "@nestjs/common";
import { SetTaxSettingsSchema, type TaxSettings } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { TaxSettingsService, type TaxSettingsRecord } from "./tax-settings.service.js";
import { parseOrBadRequest } from "./validation.js";

function toTaxSettingsResponse(settings: TaxSettingsRecord): TaxSettings {
  return {
    id: settings.id,
    branchId: settings.branchId,
    pricingMode: settings.pricingMode,
    createdAt: settings.createdAt.toISOString(),
    updatedAt: settings.updatedAt.toISOString(),
  };
}

@Controller("tax-settings")
export class TaxSettingsController {
  constructor(private readonly taxSettingsService: TaxSettingsService) {}

  @Get()
  @RequirePermission("menu.manage")
  async list(): Promise<TaxSettings[]> {
    const tenant = requireTenant();
    const settings = await this.taxSettingsService.list(tenant.restaurantId);
    return settings.map(toTaxSettingsResponse);
  }

  @Put()
  @RequirePermission("menu.manage")
  async set(@Body() body: unknown): Promise<TaxSettings> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(SetTaxSettingsSchema, body);
    const settings = await this.taxSettingsService.set({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toTaxSettingsResponse(settings);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
