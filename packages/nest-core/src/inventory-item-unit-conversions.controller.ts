import { Body, Controller, Get, Param, Put, Query, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { ConvertQuantityQuerySchema, SetUnitConversionSchema, type ConvertedQuantity, type UnitConversion } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { InventoryItemUnitConversionsService, type UnitConversionRecord } from "./inventory-item-unit-conversions.service.js";
import { parseOrBadRequest } from "./validation.js";

const ItemIdParamSchema = z.object({ itemId: z.string().uuid() });

function toConversionResponse(conversion: UnitConversionRecord): UnitConversion {
  return {
    id: conversion.id,
    itemId: conversion.itemId,
    unitId: conversion.unitId,
    factorToBaseUnit: conversion.factorToBaseUnit,
    createdAt: conversion.createdAt.toISOString(),
    updatedAt: conversion.updatedAt.toISOString(),
  };
}

/** P3-08: an inventory item's own alternate-unit conversion factors, plus
 * a convert-quantity utility endpoint — nested under the item itself since
 * a conversion factor only ever means something relative to one item. */
@Controller("inventory-items/:itemId/unit-conversions")
export class InventoryItemUnitConversionsController {
  constructor(private readonly conversionsService: InventoryItemUnitConversionsService) {}

  @Get()
  @RequirePermission("inventory.manage")
  async list(@Param() params: unknown): Promise<UnitConversion[]> {
    const tenant = requireTenant();
    const { itemId } = parseOrBadRequest(ItemIdParamSchema, params);
    const conversions = await this.conversionsService.list(tenant.restaurantId, itemId);
    return conversions.map(toConversionResponse);
  }

  @Put()
  @RequirePermission("inventory.manage")
  async setFactor(@Param() params: unknown, @Body() body: unknown): Promise<UnitConversion> {
    const tenant = requireTenant();
    const { itemId } = parseOrBadRequest(ItemIdParamSchema, params);
    const request = parseOrBadRequest(SetUnitConversionSchema, body);
    const conversion = await this.conversionsService.setFactor({ ...request, restaurantId: tenant.restaurantId, itemId, actorUserId: tenant.userId });
    return toConversionResponse(conversion);
  }

  @Get("convert")
  @RequirePermission("inventory.manage")
  async convert(@Param() params: unknown, @Query() query: unknown): Promise<ConvertedQuantity> {
    const tenant = requireTenant();
    const { itemId } = parseOrBadRequest(ItemIdParamSchema, params);
    const request = parseOrBadRequest(ConvertQuantityQuerySchema, query);
    const quantity = await this.conversionsService.convert({ ...request, restaurantId: tenant.restaurantId, itemId });
    return { quantity };
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
