import { Body, Controller, Get, Param, Patch, Post, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { CreateInventoryCategorySchema, UpdateInventoryCategorySchema, type InventoryCategory } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { InventoryCategoriesService, type InventoryCategoryRecord } from "./inventory-categories.service.js";
import { parseOrBadRequest } from "./validation.js";

const CategoryIdParamSchema = z.object({ id: z.string().uuid() });

function toCategoryResponse(category: InventoryCategoryRecord): InventoryCategory {
  return {
    id: category.id,
    name: category.name,
    sortOrder: category.sortOrder,
    status: category.status,
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
  };
}

@Controller("inventory-categories")
export class InventoryCategoriesController {
  constructor(private readonly inventoryCategoriesService: InventoryCategoriesService) {}

  @Get()
  @RequirePermission("inventory.manage")
  async list(): Promise<InventoryCategory[]> {
    const tenant = requireTenant();
    const categories = await this.inventoryCategoriesService.list(tenant.restaurantId);
    return categories.map(toCategoryResponse);
  }

  @Post()
  @RequirePermission("inventory.manage")
  async create(@Body() body: unknown): Promise<InventoryCategory> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(CreateInventoryCategorySchema, body);
    const category = await this.inventoryCategoriesService.create({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toCategoryResponse(category);
  }

  @Patch(":id")
  @RequirePermission("inventory.manage")
  async update(@Param() params: unknown, @Body() body: unknown): Promise<InventoryCategory> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(CategoryIdParamSchema, params);
    const request = parseOrBadRequest(UpdateInventoryCategorySchema, body);
    const category = await this.inventoryCategoriesService.update({ ...request, restaurantId: tenant.restaurantId, categoryId: id, actorUserId: tenant.userId });
    return toCategoryResponse(category);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
