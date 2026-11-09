import { Body, Controller, Delete, Get, Param, Put, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { SetPriceListItemSchema, type PriceListItem } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { PriceListItemsService, type PriceListItemRecord } from "./price-list-items.service.js";
import { parseOrBadRequest } from "./validation.js";

const PriceListIdParamSchema = z.object({ priceListId: z.string().uuid() });
const ItemIdParamSchema = z.object({ priceListId: z.string().uuid(), itemId: z.string().uuid() });

function toItemResponse(item: PriceListItemRecord): PriceListItem {
  return { id: item.id, priceListId: item.priceListId, productId: item.productId, variantId: item.variantId, unitPriceMinor: item.unitPriceMinor.toString() };
}

@Controller("price-lists/:priceListId/items")
export class PriceListItemsController {
  constructor(private readonly priceListItemsService: PriceListItemsService) {}

  @Get()
  @RequirePermission("menu.manage")
  async list(@Param() params: unknown): Promise<PriceListItem[]> {
    const tenant = requireTenant();
    const { priceListId } = parseOrBadRequest(PriceListIdParamSchema, params);
    const items = await this.priceListItemsService.list(tenant.restaurantId, priceListId);
    return items.map(toItemResponse);
  }

  @Put()
  @RequirePermission("menu.manage")
  async setPrice(@Param() params: unknown, @Body() body: unknown): Promise<PriceListItem> {
    const tenant = requireTenant();
    const { priceListId } = parseOrBadRequest(PriceListIdParamSchema, params);
    const request = parseOrBadRequest(SetPriceListItemSchema, body);
    const item = await this.priceListItemsService.setPrice({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.userId,
      priceListId,
      productId: request.productId,
      variantId: request.variantId,
      unitPriceMinor: BigInt(request.unitPriceMinor),
    });
    return toItemResponse(item);
  }

  @Delete(":itemId")
  @RequirePermission("menu.manage")
  async removePrice(@Param() params: unknown): Promise<{ removed: true }> {
    const tenant = requireTenant();
    const { priceListId, itemId } = parseOrBadRequest(ItemIdParamSchema, params);
    await this.priceListItemsService.removePrice({ restaurantId: tenant.restaurantId, actorUserId: tenant.userId, priceListId, itemId });
    return { removed: true };
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
