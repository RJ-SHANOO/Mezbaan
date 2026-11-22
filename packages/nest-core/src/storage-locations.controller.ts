import { Body, Controller, Get, Param, Patch, Post, Query, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { CreateStorageLocationSchema, ListStorageLocationsQuerySchema, UpdateStorageLocationSchema, type StorageLocation } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { StorageLocationsService, type StorageLocationRecord } from "./storage-locations.service.js";
import { parseOrBadRequest } from "./validation.js";

const LocationIdParamSchema = z.object({ id: z.string().uuid() });

function toLocationResponse(location: StorageLocationRecord): StorageLocation {
  return {
    id: location.id,
    branchId: location.branchId,
    name: location.name,
    sortOrder: location.sortOrder,
    createdAt: location.createdAt.toISOString(),
    updatedAt: location.updatedAt.toISOString(),
  };
}

@Controller("storage-locations")
export class StorageLocationsController {
  constructor(private readonly storageLocationsService: StorageLocationsService) {}

  @Get()
  @RequirePermission("inventory.manage")
  async list(@Query() query: unknown): Promise<StorageLocation[]> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ListStorageLocationsQuerySchema, query);
    const locations = await this.storageLocationsService.list(tenant.restaurantId, request.branchId);
    return locations.map(toLocationResponse);
  }

  @Post()
  @RequirePermission("inventory.manage")
  async create(@Body() body: unknown): Promise<StorageLocation> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(CreateStorageLocationSchema, body);
    const location = await this.storageLocationsService.create({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toLocationResponse(location);
  }

  @Patch(":id")
  @RequirePermission("inventory.manage")
  async update(@Param() params: unknown, @Body() body: unknown): Promise<StorageLocation> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(LocationIdParamSchema, params);
    const request = parseOrBadRequest(UpdateStorageLocationSchema, body);
    const location = await this.storageLocationsService.update({ ...request, restaurantId: tenant.restaurantId, locationId: id, actorUserId: tenant.userId });
    return toLocationResponse(location);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
