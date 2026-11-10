import { Body, Controller, Get, Param, Patch, Post, Query, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { CreateFloorSchema, ListFloorsQuerySchema, UpdateFloorSchema, type Floor } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { FloorsService, type FloorRecord } from "./floors.service.js";
import { parseOrBadRequest } from "./validation.js";

const FloorIdParamSchema = z.object({ id: z.string().uuid() });

function toFloorResponse(floor: FloorRecord): Floor {
  return {
    id: floor.id,
    branchId: floor.branchId,
    name: floor.name,
    sortOrder: floor.sortOrder,
    createdAt: floor.createdAt.toISOString(),
    updatedAt: floor.updatedAt.toISOString(),
  };
}

@Controller("floors")
export class FloorsController {
  constructor(private readonly floorsService: FloorsService) {}

  @Get()
  @RequirePermission("tables.manage")
  async list(@Query() query: unknown): Promise<Floor[]> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ListFloorsQuerySchema, query);
    const floors = await this.floorsService.list(tenant.restaurantId, request.branchId);
    return floors.map(toFloorResponse);
  }

  @Post()
  @RequirePermission("tables.manage")
  async create(@Body() body: unknown): Promise<Floor> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(CreateFloorSchema, body);
    const floor = await this.floorsService.create({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toFloorResponse(floor);
  }

  @Patch(":id")
  @RequirePermission("tables.manage")
  async update(@Param() params: unknown, @Body() body: unknown): Promise<Floor> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(FloorIdParamSchema, params);
    const request = parseOrBadRequest(UpdateFloorSchema, body);
    const floor = await this.floorsService.update({ ...request, restaurantId: tenant.restaurantId, floorId: id, actorUserId: tenant.userId });
    return toFloorResponse(floor);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
