import { Body, Controller, Get, Param, Patch, Post, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { CreateServiceChargeSettingSchema, UpdateServiceChargeSettingSchema, type ServiceChargeSetting } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { ServiceChargeSettingsService, type ServiceChargeSettingRecord } from "./service-charge-settings.service.js";
import { parseOrBadRequest } from "./validation.js";

const ServiceChargeSettingIdParamSchema = z.object({ id: z.string().uuid() });

function toServiceChargeSettingResponse(setting: ServiceChargeSettingRecord): ServiceChargeSetting {
  return {
    id: setting.id,
    rateBasisPoints: setting.rateBasisPoints,
    branchId: setting.branchId,
    orderType: setting.orderType,
    isTaxable: setting.isTaxable,
    isActive: setting.isActive,
    createdAt: setting.createdAt.toISOString(),
    updatedAt: setting.updatedAt.toISOString(),
  };
}

@Controller("service-charge-settings")
export class ServiceChargeSettingsController {
  constructor(private readonly serviceChargeSettingsService: ServiceChargeSettingsService) {}

  @Get()
  @RequirePermission("menu.manage")
  async list(): Promise<ServiceChargeSetting[]> {
    const tenant = requireTenant();
    const settings = await this.serviceChargeSettingsService.list(tenant.restaurantId);
    return settings.map(toServiceChargeSettingResponse);
  }

  @Post()
  @RequirePermission("menu.manage")
  async create(@Body() body: unknown): Promise<ServiceChargeSetting> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(CreateServiceChargeSettingSchema, body);
    const setting = await this.serviceChargeSettingsService.create({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toServiceChargeSettingResponse(setting);
  }

  @Patch(":id")
  @RequirePermission("menu.manage")
  async update(@Param() params: unknown, @Body() body: unknown): Promise<ServiceChargeSetting> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(ServiceChargeSettingIdParamSchema, params);
    const request = parseOrBadRequest(UpdateServiceChargeSettingSchema, body);
    const setting = await this.serviceChargeSettingsService.update({
      ...request,
      restaurantId: tenant.restaurantId,
      serviceChargeSettingId: id,
      actorUserId: tenant.userId,
    });
    return toServiceChargeSettingResponse(setting);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
