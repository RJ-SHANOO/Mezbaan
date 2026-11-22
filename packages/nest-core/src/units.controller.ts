import { Body, Controller, Get, Param, Patch, Post, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { CreateUnitSchema, UpdateUnitSchema, type Unit } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { UnitsService, type UnitRecord } from "./units.service.js";
import { parseOrBadRequest } from "./validation.js";

const UnitIdParamSchema = z.object({ id: z.string().uuid() });

function toUnitResponse(unit: UnitRecord): Unit {
  return { id: unit.id, name: unit.name, abbreviation: unit.abbreviation, createdAt: unit.createdAt.toISOString() };
}

@Controller("units")
export class UnitsController {
  constructor(private readonly unitsService: UnitsService) {}

  @Get()
  @RequirePermission("inventory.manage")
  async list(): Promise<Unit[]> {
    const tenant = requireTenant();
    const units = await this.unitsService.list(tenant.restaurantId);
    return units.map(toUnitResponse);
  }

  @Post()
  @RequirePermission("inventory.manage")
  async create(@Body() body: unknown): Promise<Unit> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(CreateUnitSchema, body);
    const unit = await this.unitsService.create({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toUnitResponse(unit);
  }

  @Patch(":id")
  @RequirePermission("inventory.manage")
  async update(@Param() params: unknown, @Body() body: unknown): Promise<Unit> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(UnitIdParamSchema, params);
    const request = parseOrBadRequest(UpdateUnitSchema, body);
    const unit = await this.unitsService.update({ ...request, restaurantId: tenant.restaurantId, unitId: id, actorUserId: tenant.userId });
    return toUnitResponse(unit);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
