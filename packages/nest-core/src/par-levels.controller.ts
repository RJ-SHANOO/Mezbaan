import { Body, Controller, Delete, Get, Param, Post, Query, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import {
  ListLowStockQuerySchema,
  ListParLevelsQuerySchema,
  SetParLevelSchema,
  type ItemParLevel,
  type LowStockItem,
} from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { ParLevelsService, type ItemParLevelRecord, type LowStockItemRecord } from "./par-levels.service.js";
import { parseOrBadRequest } from "./validation.js";

const ParLevelIdParamSchema = z.object({ id: z.string().uuid() });

function toLevelResponse(level: ItemParLevelRecord): ItemParLevel {
  return {
    id: level.id,
    storageLocationId: level.storageLocationId,
    itemId: level.itemId,
    minQuantity: level.minQuantity,
    parQuantity: level.parQuantity,
    updatedByUserId: level.updatedByUserId,
    createdAt: level.createdAt.toISOString(),
    updatedAt: level.updatedAt.toISOString(),
  };
}

function toLowStockResponse(item: LowStockItemRecord): LowStockItem {
  return { storageLocationId: item.storageLocationId, itemId: item.itemId, quantity: item.quantity, minQuantity: item.minQuantity, parQuantity: item.parQuantity };
}

@Controller("item-par-levels")
export class ParLevelsController {
  constructor(private readonly parLevelsService: ParLevelsService) {}

  @Get()
  @RequirePermission("inventory.manage")
  async list(@Query() query: unknown): Promise<ItemParLevel[]> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ListParLevelsQuerySchema, query);
    const levels = await this.parLevelsService.listLevels({ restaurantId: tenant.restaurantId, ...request });
    return levels.map(toLevelResponse);
  }

  @Post()
  @RequirePermission("inventory.manage")
  async set(@Body() body: unknown): Promise<ItemParLevel> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(SetParLevelSchema, body);
    const level = await this.parLevelsService.setLevel({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toLevelResponse(level);
  }

  @Delete(":id")
  @RequirePermission("inventory.manage")
  async delete(@Param() params: unknown): Promise<{ success: true }> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(ParLevelIdParamSchema, params);
    await this.parLevelsService.deleteLevel({ restaurantId: tenant.restaurantId, actorUserId: tenant.userId, parLevelId: id });
    return { success: true };
  }
}

@Controller("low-stock-items")
export class LowStockController {
  constructor(private readonly parLevelsService: ParLevelsService) {}

  @Get()
  @RequirePermission("inventory.manage")
  async list(@Query() query: unknown): Promise<LowStockItem[]> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ListLowStockQuerySchema, query);
    const items = await this.parLevelsService.listLowStock({ restaurantId: tenant.restaurantId, ...request });
    return items.map(toLowStockResponse);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
