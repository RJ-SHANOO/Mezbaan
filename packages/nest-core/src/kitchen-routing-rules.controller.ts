import { Body, Controller, Delete, Get, Param, Put, Post, Query, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import {
  CreateKitchenRoutingRuleSchema,
  ListKitchenRoutingRulesQuerySchema,
  ResolveKitchenStationQuerySchema,
  UpdateKitchenRoutingRuleSchema,
  type KitchenRoutingRule,
  type ResolvedKitchenStation,
} from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { KitchenRoutingRulesService, type KitchenRoutingRuleRecord } from "./kitchen-routing-rules.service.js";
import { parseOrBadRequest } from "./validation.js";

const RuleIdParamSchema = z.object({ id: z.string().uuid() });

function toRuleResponse(rule: KitchenRoutingRuleRecord): KitchenRoutingRule {
  return {
    id: rule.id,
    branchId: rule.branchId,
    stationId: rule.stationId,
    categoryId: rule.categoryId,
    productId: rule.productId,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

@Controller("kitchen-routing-rules")
export class KitchenRoutingRulesController {
  constructor(private readonly kitchenRoutingRulesService: KitchenRoutingRulesService) {}

  @Get()
  @RequirePermission("kitchen.manage")
  async list(@Query() query: unknown): Promise<KitchenRoutingRule[]> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ListKitchenRoutingRulesQuerySchema, query);
    const rules = await this.kitchenRoutingRulesService.list(tenant.restaurantId, request.branchId);
    return rules.map(toRuleResponse);
  }

  @Get("resolve")
  @RequirePermission("kitchen.manage")
  async resolve(@Query() query: unknown): Promise<ResolvedKitchenStation> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ResolveKitchenStationQuerySchema, query);
    const stationId = await this.kitchenRoutingRulesService.resolveStationForProduct({ restaurantId: tenant.restaurantId, ...request });
    return { stationId };
  }

  @Post()
  @RequirePermission("kitchen.manage")
  async create(@Body() body: unknown): Promise<KitchenRoutingRule> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(CreateKitchenRoutingRuleSchema, body);
    const rule = await this.kitchenRoutingRulesService.create({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toRuleResponse(rule);
  }

  @Put(":id")
  @RequirePermission("kitchen.manage")
  async update(@Param() params: unknown, @Body() body: unknown): Promise<KitchenRoutingRule> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(RuleIdParamSchema, params);
    const { stationId } = parseOrBadRequest(UpdateKitchenRoutingRuleSchema, body);
    const rule = await this.kitchenRoutingRulesService.update({ restaurantId: tenant.restaurantId, actorUserId: tenant.userId, ruleId: id, stationId });
    return toRuleResponse(rule);
  }

  @Delete(":id")
  @RequirePermission("kitchen.manage")
  async delete(@Param() params: unknown): Promise<void> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(RuleIdParamSchema, params);
    await this.kitchenRoutingRulesService.delete(tenant.restaurantId, tenant.userId, id);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
