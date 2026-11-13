import { Body, Controller, Get, Param, Patch, Post, Query, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import {
  CreatePriceListSchema,
  ResolvePriceQuerySchema,
  UpdatePriceListSchema,
  type PriceList,
  type ResolvedPrice,
} from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { PriceListsService, type PriceListRecord } from "./price-lists.service.js";
import { PriceResolutionService } from "./price-resolution.service.js";
import { parseOrBadRequest } from "./validation.js";

const PriceListIdParamSchema = z.object({ id: z.string().uuid() });

function toPriceListResponse(priceList: PriceListRecord): PriceList {
  return {
    id: priceList.id,
    name: priceList.name,
    version: priceList.version,
    currency: priceList.currency,
    branchId: priceList.branchId,
    orderType: priceList.orderType,
    effectiveFrom: priceList.effectiveFrom?.toISOString() ?? null,
    effectiveTo: priceList.effectiveTo?.toISOString() ?? null,
    priority: priceList.priority,
    status: priceList.status,
    publishedAt: priceList.publishedAt?.toISOString() ?? null,
    createdAt: priceList.createdAt.toISOString(),
    updatedAt: priceList.updatedAt.toISOString(),
  };
}

@Controller("price-lists")
export class PriceListsController {
  constructor(
    private readonly priceListsService: PriceListsService,
    private readonly priceResolutionService: PriceResolutionService,
  ) {}

  @Get("resolve")
  @RequirePermission("menu.manage")
  async resolve(@Query() query: unknown): Promise<ResolvedPrice | null> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ResolvePriceQuerySchema, query);
    const resolved = await this.priceResolutionService.resolvePrice({
      restaurantId: tenant.restaurantId,
      branchId: request.branchId,
      orderType: request.orderType,
      productId: request.productId,
      variantId: request.variantId,
      modifierOptionId: request.modifierOptionId,
      at: request.at ? new Date(request.at) : undefined,
    });
    if (!resolved) return null;
    return {
      priceListId: resolved.priceListId,
      priceListName: resolved.priceListName,
      version: resolved.version,
      currency: resolved.currency,
      unitPriceMinor: resolved.unitPriceMinor.toString(),
    };
  }

  @Get()
  @RequirePermission("menu.manage")
  async list(): Promise<PriceList[]> {
    const tenant = requireTenant();
    const priceLists = await this.priceListsService.list(tenant.restaurantId);
    return priceLists.map(toPriceListResponse);
  }

  @Post()
  @RequirePermission("menu.manage")
  async create(@Body() body: unknown): Promise<PriceList> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(CreatePriceListSchema, body);
    const priceList = await this.priceListsService.create({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toPriceListResponse(priceList);
  }

  @Patch(":id")
  @RequirePermission("menu.manage")
  async update(@Param() params: unknown, @Body() body: unknown): Promise<PriceList> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(PriceListIdParamSchema, params);
    const request = parseOrBadRequest(UpdatePriceListSchema, body);
    const priceList = await this.priceListsService.update({ ...request, restaurantId: tenant.restaurantId, priceListId: id, actorUserId: tenant.userId });
    return toPriceListResponse(priceList);
  }

  @Post(":id/publish")
  @RequirePermission("menu.manage")
  async publish(@Param() params: unknown): Promise<PriceList> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(PriceListIdParamSchema, params);
    const priceList = await this.priceListsService.publish({ restaurantId: tenant.restaurantId, priceListId: id, actorUserId: tenant.userId });
    return toPriceListResponse(priceList);
  }

  @Post(":id/archive")
  @RequirePermission("menu.manage")
  async archive(@Param() params: unknown): Promise<PriceList> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(PriceListIdParamSchema, params);
    const priceList = await this.priceListsService.archive({ restaurantId: tenant.restaurantId, priceListId: id, actorUserId: tenant.userId });
    return toPriceListResponse(priceList);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
