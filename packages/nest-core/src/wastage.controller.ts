import { Body, Controller, Get, Put, Post, Query, UnauthorizedException } from "@nestjs/common";
import {
  ListWastageEntriesQuerySchema,
  RecordWastageSchema,
  SetWastageReasonCodeSchema,
  UpdateWastageLimitSettingsSchema,
  type WastageEntry,
  type WastageEntryPage,
  type WastageLimitSettings,
  type WastageReasonCode,
} from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import {
  WastageService,
  type WastageEntryRecord,
  type WastageLimitSettingsRecord,
  type WastageReasonCodeRecord,
} from "./wastage.service.js";
import { parseOrBadRequest } from "./validation.js";

function toReasonCodeResponse(reasonCode: WastageReasonCodeRecord): WastageReasonCode {
  return {
    id: reasonCode.id,
    code: reasonCode.code,
    label: reasonCode.label,
    isActive: reasonCode.isActive,
    createdAt: reasonCode.createdAt.toISOString(),
    updatedAt: reasonCode.updatedAt.toISOString(),
  };
}

function toLimitSettingsResponse(settings: WastageLimitSettingsRecord): WastageLimitSettings {
  return {
    maxUnapprovedCostMinor: settings.maxUnapprovedCostMinor?.toString() ?? null,
    updatedByUserId: settings.updatedByUserId,
    updatedAt: settings.updatedAt.toISOString(),
  };
}

function toEntryResponse(entry: WastageEntryRecord): WastageEntry {
  return {
    id: entry.id,
    branchId: entry.branchId,
    storageLocationId: entry.storageLocationId,
    itemId: entry.itemId,
    quantity: entry.quantity,
    reasonCode: entry.reasonCode,
    costMinor: entry.costMinor?.toString() ?? null,
    currency: entry.currency,
    requiredApproval: entry.requiredApproval,
    approvedByUserId: entry.approvedByUserId,
    actorUserId: entry.actorUserId,
    note: entry.note,
    createdAt: entry.createdAt.toISOString(),
  };
}

@Controller("wastage-reason-codes")
export class WastageReasonCodesController {
  constructor(private readonly wastageService: WastageService) {}

  @Get()
  @RequirePermission("inventory.manage")
  async list(): Promise<WastageReasonCode[]> {
    const tenant = requireTenant();
    const reasonCodes = await this.wastageService.listReasonCodes(tenant.restaurantId);
    return reasonCodes.map(toReasonCodeResponse);
  }

  @Post()
  @RequirePermission("inventory.manage")
  async set(@Body() body: unknown): Promise<WastageReasonCode> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(SetWastageReasonCodeSchema, body);
    const reasonCode = await this.wastageService.setReasonCode({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toReasonCodeResponse(reasonCode);
  }
}

@Controller("wastage-limit-settings")
export class WastageLimitSettingsController {
  constructor(private readonly wastageService: WastageService) {}

  @Get()
  @RequirePermission("inventory.manage")
  async get(): Promise<WastageLimitSettings | null> {
    const tenant = requireTenant();
    const settings = await this.wastageService.getLimitSettings(tenant.restaurantId);
    return settings ? toLimitSettingsResponse(settings) : null;
  }

  @Put()
  @RequirePermission("inventory.manage")
  async update(@Body() body: unknown): Promise<WastageLimitSettings> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(UpdateWastageLimitSettingsSchema, body);
    const settings = await this.wastageService.updateLimitSettings({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.userId,
      maxUnapprovedCostMinor: request.maxUnapprovedCostMinor === null ? null : BigInt(request.maxUnapprovedCostMinor),
    });
    return toLimitSettingsResponse(settings);
  }
}

@Controller("wastage-entries")
export class WastageEntriesController {
  constructor(private readonly wastageService: WastageService) {}

  @Get()
  @RequirePermission("inventory.adjust")
  async list(@Query() query: unknown): Promise<WastageEntryPage> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ListWastageEntriesQuerySchema, query);
    const page = await this.wastageService.list({ restaurantId: tenant.restaurantId, ...request });
    return { items: page.items.map(toEntryResponse), nextCursor: page.nextCursor };
  }

  @Post()
  @RequirePermission("inventory.adjust")
  async record(@Body() body: unknown): Promise<WastageEntry> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(RecordWastageSchema, body);
    const result = await this.wastageService.recordWastage({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toEntryResponse(result.entry);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
