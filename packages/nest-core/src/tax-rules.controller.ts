import { Body, Controller, Get, Param, Patch, Post, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { CreateTaxRuleSchema, UpdateTaxRuleSchema, type TaxRule } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { TaxRulesService, type TaxRuleRecord } from "./tax-rules.service.js";
import { parseOrBadRequest } from "./validation.js";

const TaxRuleIdParamSchema = z.object({ id: z.string().uuid() });

function toTaxRuleResponse(taxRule: TaxRuleRecord): TaxRule {
  return {
    id: taxRule.id,
    name: taxRule.name,
    rateBasisPoints: taxRule.rateBasisPoints,
    branchId: taxRule.branchId,
    orderType: taxRule.orderType,
    isActive: taxRule.isActive,
    createdAt: taxRule.createdAt.toISOString(),
    updatedAt: taxRule.updatedAt.toISOString(),
  };
}

@Controller("tax-rules")
export class TaxRulesController {
  constructor(private readonly taxRulesService: TaxRulesService) {}

  @Get()
  @RequirePermission("menu.manage")
  async list(): Promise<TaxRule[]> {
    const tenant = requireTenant();
    const taxRules = await this.taxRulesService.list(tenant.restaurantId);
    return taxRules.map(toTaxRuleResponse);
  }

  @Post()
  @RequirePermission("menu.manage")
  async create(@Body() body: unknown): Promise<TaxRule> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(CreateTaxRuleSchema, body);
    const taxRule = await this.taxRulesService.create({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toTaxRuleResponse(taxRule);
  }

  @Patch(":id")
  @RequirePermission("menu.manage")
  async update(@Param() params: unknown, @Body() body: unknown): Promise<TaxRule> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(TaxRuleIdParamSchema, params);
    const request = parseOrBadRequest(UpdateTaxRuleSchema, body);
    const taxRule = await this.taxRulesService.update({ ...request, restaurantId: tenant.restaurantId, taxRuleId: id, actorUserId: tenant.userId });
    return toTaxRuleResponse(taxRule);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
