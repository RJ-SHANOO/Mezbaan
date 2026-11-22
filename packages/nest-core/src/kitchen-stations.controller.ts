import { Body, Controller, Get, Param, Patch, Post, Query, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { CreateKitchenStationSchema, ListKitchenStationsQuerySchema, UpdateKitchenStationSchema, type KitchenStation } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { KitchenStationsService, type KitchenStationRecord } from "./kitchen-stations.service.js";
import { parseOrBadRequest } from "./validation.js";

const StationIdParamSchema = z.object({ id: z.string().uuid() });

function toStationResponse(station: KitchenStationRecord): KitchenStation {
  return {
    id: station.id,
    branchId: station.branchId,
    name: station.name,
    sortOrder: station.sortOrder,
    printerHost: station.printerHost,
    printerPort: station.printerPort,
    createdAt: station.createdAt.toISOString(),
    updatedAt: station.updatedAt.toISOString(),
  };
}

@Controller("kitchen-stations")
export class KitchenStationsController {
  constructor(private readonly kitchenStationsService: KitchenStationsService) {}

  @Get()
  @RequirePermission("kitchen.manage")
  async list(@Query() query: unknown): Promise<KitchenStation[]> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ListKitchenStationsQuerySchema, query);
    const stations = await this.kitchenStationsService.list(tenant.restaurantId, request.branchId);
    return stations.map(toStationResponse);
  }

  @Post()
  @RequirePermission("kitchen.manage")
  async create(@Body() body: unknown): Promise<KitchenStation> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(CreateKitchenStationSchema, body);
    const station = await this.kitchenStationsService.create({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toStationResponse(station);
  }

  @Patch(":id")
  @RequirePermission("kitchen.manage")
  async update(@Param() params: unknown, @Body() body: unknown): Promise<KitchenStation> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(StationIdParamSchema, params);
    const request = parseOrBadRequest(UpdateKitchenStationSchema, body);
    const station = await this.kitchenStationsService.update({ ...request, restaurantId: tenant.restaurantId, stationId: id, actorUserId: tenant.userId });
    return toStationResponse(station);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
