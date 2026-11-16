import { Body, Controller, Get, Put, UnauthorizedException } from "@nestjs/common";
import { SetReceiptSettingsSchema, type ReceiptSettings } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { ReceiptSettingsService, type ReceiptSettingsRecord } from "./receipt-settings.service.js";
import { parseOrBadRequest } from "./validation.js";

function toResponse(row: ReceiptSettingsRecord): ReceiptSettings {
  return {
    logoUrl: row.logoUrl,
    headerText: row.headerText,
    footerText: row.footerText,
    showTaxBreakdown: row.showTaxBreakdown,
    showServiceCharge: row.showServiceCharge,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** P2-33, admin side: configuring the receipt — same menu.manage tier as
 * tax/service-charge/payment-method settings, lives in api-admin's
 * CatalogModule. */
@Controller("receipt-settings")
export class ReceiptSettingsController {
  constructor(private readonly receiptSettingsService: ReceiptSettingsService) {}

  @Get()
  @RequirePermission("menu.manage")
  async get(): Promise<ReceiptSettings> {
    const tenant = requireTenant();
    const settings = await this.receiptSettingsService.get(tenant.restaurantId);
    return toResponse(settings);
  }

  @Put()
  @RequirePermission("menu.manage")
  async set(@Body() body: unknown): Promise<ReceiptSettings> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(SetReceiptSettingsSchema, body);
    const settings = await this.receiptSettingsService.set({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toResponse(settings);
  }
}

/** P2-33, POS side: read-only — a terminal fetches the current receipt
 * settings (when online) to render a receipt with. Lives in api-pos's
 * OrdersModule, same "each module provides its own service copy"
 * convention as every other shared stateless service this phase. No
 * offline/snapshot-synced path yet — see docs/task-log.md#p2-33. */
@Controller("receipt-settings")
export class ReceiptSettingsLookupController {
  constructor(private readonly receiptSettingsService: ReceiptSettingsService) {}

  @Get()
  @RequirePermission("pos.sell")
  async get(): Promise<ReceiptSettings> {
    const tenant = requireTenant();
    const settings = await this.receiptSettingsService.get(tenant.restaurantId);
    return toResponse(settings);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
