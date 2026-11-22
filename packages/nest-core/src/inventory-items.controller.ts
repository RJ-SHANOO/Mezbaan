import { Body, Controller, Get, Param, Patch, Post, Query, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { CreateInventoryItemSchema, ListInventoryItemsQuerySchema, UpdateInventoryItemSchema, type InventoryItem } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { InventoryItemsService, type InventoryItemRecord } from "./inventory-items.service.js";
import { parseOrBadRequest } from "./validation.js";

const ItemIdParamSchema = z.object({ id: z.string().uuid() });

function toItemResponse(item: InventoryItemRecord): InventoryItem {
  return {
    id: item.id,
    categoryId: item.categoryId,
    name: item.name,
    sku: item.sku,
    barcode: item.barcode,
    baseUnitId: item.baseUnitId,
    purchaseUnitId: item.purchaseUnitId,
    status: item.status,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

@Controller("inventory-items")
export class InventoryItemsController {
  constructor(private readonly inventoryItemsService: InventoryItemsService) {}

  @Get()
  @RequirePermission("inventory.manage")
  async list(@Query() query: unknown): Promise<InventoryItem[]> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ListInventoryItemsQuerySchema, query);
    const items = await this.inventoryItemsService.list(tenant.restaurantId, request.categoryId);
    return items.map(toItemResponse);
  }

  @Post()
  @RequirePermission("inventory.manage")
  async create(@Body() body: unknown): Promise<InventoryItem> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(CreateInventoryItemSchema, body);
    const item = await this.inventoryItemsService.create({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toItemResponse(item);
  }

  @Patch(":id")
  @RequirePermission("inventory.manage")
  async update(@Param() params: unknown, @Body() body: unknown): Promise<InventoryItem> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(ItemIdParamSchema, params);
    const request = parseOrBadRequest(UpdateInventoryItemSchema, body);
    const item = await this.inventoryItemsService.update({ ...request, restaurantId: tenant.restaurantId, itemId: id, actorUserId: tenant.userId });
    return toItemResponse(item);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
