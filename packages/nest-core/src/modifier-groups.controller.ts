import { Body, Controller, Get, Param, Patch, Post, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { CreateModifierGroupSchema, UpdateModifierGroupSchema, type ModifierGroup } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { ModifierGroupsService, type ModifierGroupRecord } from "./modifier-groups.service.js";
import { parseOrBadRequest } from "./validation.js";

const GroupIdParamSchema = z.object({ id: z.string().uuid() });

function toGroupResponse(group: ModifierGroupRecord): ModifierGroup {
  return {
    id: group.id,
    name: group.name,
    minSelections: group.minSelections,
    maxSelections: group.maxSelections,
    sortOrder: group.sortOrder,
    status: group.status,
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
  };
}

@Controller("modifier-groups")
export class ModifierGroupsController {
  constructor(private readonly modifierGroupsService: ModifierGroupsService) {}

  @Get()
  @RequirePermission("menu.manage")
  async list(): Promise<ModifierGroup[]> {
    const tenant = requireTenant();
    const groups = await this.modifierGroupsService.list(tenant.restaurantId);
    return groups.map(toGroupResponse);
  }

  @Post()
  @RequirePermission("menu.manage")
  async create(@Body() body: unknown): Promise<ModifierGroup> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(CreateModifierGroupSchema, body);
    const group = await this.modifierGroupsService.create({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toGroupResponse(group);
  }

  @Patch(":id")
  @RequirePermission("menu.manage")
  async update(@Param() params: unknown, @Body() body: unknown): Promise<ModifierGroup> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(GroupIdParamSchema, params);
    const request = parseOrBadRequest(UpdateModifierGroupSchema, body);
    const group = await this.modifierGroupsService.update({
      ...request,
      restaurantId: tenant.restaurantId,
      modifierGroupId: id,
      actorUserId: tenant.userId,
    });
    return toGroupResponse(group);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
