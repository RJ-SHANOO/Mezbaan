import { Body, Controller, Get, Param, Patch, Post, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { CreateModifierOptionSchema, UpdateModifierOptionSchema, type ModifierOption } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { ModifierOptionsService, type ModifierOptionRecord } from "./modifier-options.service.js";
import { parseOrBadRequest } from "./validation.js";

const GroupIdParamSchema = z.object({ groupId: z.string().uuid() });
const OptionIdParamSchema = z.object({ groupId: z.string().uuid(), optionId: z.string().uuid() });

function toOptionResponse(option: ModifierOptionRecord): ModifierOption {
  return {
    id: option.id,
    modifierGroupId: option.modifierGroupId,
    name: option.name,
    sortOrder: option.sortOrder,
    status: option.status,
    createdAt: option.createdAt.toISOString(),
    updatedAt: option.updatedAt.toISOString(),
  };
}

@Controller("modifier-groups/:groupId/options")
export class ModifierOptionsController {
  constructor(private readonly modifierOptionsService: ModifierOptionsService) {}

  @Get()
  @RequirePermission("menu.manage")
  async list(@Param() params: unknown): Promise<ModifierOption[]> {
    const tenant = requireTenant();
    const { groupId } = parseOrBadRequest(GroupIdParamSchema, params);
    const options = await this.modifierOptionsService.list(tenant.restaurantId, groupId);
    return options.map(toOptionResponse);
  }

  @Post()
  @RequirePermission("menu.manage")
  async create(@Param() params: unknown, @Body() body: unknown): Promise<ModifierOption> {
    const tenant = requireTenant();
    const { groupId } = parseOrBadRequest(GroupIdParamSchema, params);
    const request = parseOrBadRequest(CreateModifierOptionSchema, body);
    const option = await this.modifierOptionsService.create({
      ...request,
      restaurantId: tenant.restaurantId,
      modifierGroupId: groupId,
      actorUserId: tenant.userId,
    });
    return toOptionResponse(option);
  }

  @Patch(":optionId")
  @RequirePermission("menu.manage")
  async update(@Param() params: unknown, @Body() body: unknown): Promise<ModifierOption> {
    const tenant = requireTenant();
    const { optionId } = parseOrBadRequest(OptionIdParamSchema, params);
    const request = parseOrBadRequest(UpdateModifierOptionSchema, body);
    const option = await this.modifierOptionsService.update({
      ...request,
      restaurantId: tenant.restaurantId,
      optionId,
      actorUserId: tenant.userId,
    });
    return toOptionResponse(option);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
