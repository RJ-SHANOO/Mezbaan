import { Body, Controller, Get, Param, Patch, Post, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { CreateComboSchema, UpdateComboSchema, type Combo } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { CombosService, type ComboRecord } from "./combos.service.js";
import { parseOrBadRequest } from "./validation.js";

const ComboIdParamSchema = z.object({ id: z.string().uuid() });

function toComboResponse(combo: ComboRecord): Combo {
  return {
    id: combo.id,
    name: combo.name,
    sortOrder: combo.sortOrder,
    status: combo.status,
    imageUrl: combo.imageUrl,
    createdAt: combo.createdAt.toISOString(),
    updatedAt: combo.updatedAt.toISOString(),
  };
}

@Controller("combos")
export class CombosController {
  constructor(private readonly combosService: CombosService) {}

  @Get()
  @RequirePermission("menu.manage")
  async list(): Promise<Combo[]> {
    const tenant = requireTenant();
    const combos = await this.combosService.list(tenant.restaurantId);
    return combos.map(toComboResponse);
  }

  @Post()
  @RequirePermission("menu.manage")
  async create(@Body() body: unknown): Promise<Combo> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(CreateComboSchema, body);
    const combo = await this.combosService.create({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toComboResponse(combo);
  }

  @Patch(":id")
  @RequirePermission("menu.manage")
  async update(@Param() params: unknown, @Body() body: unknown): Promise<Combo> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(ComboIdParamSchema, params);
    const request = parseOrBadRequest(UpdateComboSchema, body);
    const combo = await this.combosService.update({ ...request, restaurantId: tenant.restaurantId, comboId: id, actorUserId: tenant.userId });
    return toComboResponse(combo);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
