import { Body, Controller, Get, Param, Patch, Post, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { CreateCategorySchema, UpdateCategorySchema, type Category } from "@mezbaan/contracts";
import { CategoriesService, type CategoryRecord } from "./categories.service.js";
import { RequirePermission } from "./permission.decorator.js";
import { getTenantContext } from "./tenant-context.js";
import { parseOrBadRequest } from "./validation.js";

const CategoryIdParamSchema = z.object({ id: z.string().uuid() });

function toCategoryResponse(category: CategoryRecord): Category {
  return {
    id: category.id,
    name: category.name,
    sortOrder: category.sortOrder,
    status: category.status,
    imageUrl: category.imageUrl,
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
  };
}

@Controller("categories")
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  @RequirePermission("menu.manage")
  async list(): Promise<Category[]> {
    const tenant = requireTenant();
    const categories = await this.categoriesService.list(tenant.restaurantId);
    return categories.map(toCategoryResponse);
  }

  @Post()
  @RequirePermission("menu.manage")
  async create(@Body() body: unknown): Promise<Category> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(CreateCategorySchema, body);
    const category = await this.categoriesService.create({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toCategoryResponse(category);
  }

  @Patch(":id")
  @RequirePermission("menu.manage")
  async update(@Param() params: unknown, @Body() body: unknown): Promise<Category> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(CategoryIdParamSchema, params);
    const request = parseOrBadRequest(UpdateCategorySchema, body);
    const category = await this.categoriesService.update({
      ...request,
      restaurantId: tenant.restaurantId,
      categoryId: id,
      actorUserId: tenant.userId,
    });
    return toCategoryResponse(category);
  }
}

/** PermissionGuard already requires authentication for every route on this
 * controller (@RequirePermission implies it), so restaurantId/userId are always
 * non-null here — this just narrows the type instead of asserting it. */
function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
