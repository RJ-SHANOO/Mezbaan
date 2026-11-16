import { Body, Controller, Get, Put, UnauthorizedException } from "@nestjs/common";
import { SetPaymentMethodSettingSchema, type PaymentMethodSetting } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { PaymentMethodSettingsService, type PaymentMethodSettingRecord } from "./payment-method-settings.service.js";
import { parseOrBadRequest } from "./validation.js";

function toSettingResponse(setting: PaymentMethodSettingRecord): PaymentMethodSetting {
  return {
    id: setting.id,
    method: setting.method,
    enabled: setting.enabled,
    createdAt: setting.createdAt.toISOString(),
    updatedAt: setting.updatedAt.toISOString(),
  };
}

@Controller("payment-method-settings")
export class PaymentMethodSettingsController {
  constructor(private readonly paymentMethodSettingsService: PaymentMethodSettingsService) {}

  @Get()
  @RequirePermission("menu.manage")
  async list(): Promise<PaymentMethodSetting[]> {
    const tenant = requireTenant();
    const settings = await this.paymentMethodSettingsService.list(tenant.restaurantId);
    return settings.map(toSettingResponse);
  }

  @Put()
  @RequirePermission("menu.manage")
  async set(@Body() body: unknown): Promise<PaymentMethodSetting> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(SetPaymentMethodSettingSchema, body);
    const setting = await this.paymentMethodSettingsService.set({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toSettingResponse(setting);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
