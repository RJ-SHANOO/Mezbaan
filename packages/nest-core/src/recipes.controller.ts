import { Body, Controller, Delete, Get, Put, Query, UnauthorizedException, NotFoundException } from "@nestjs/common";
import { CreateOrReplaceRecipeSchema, GetRecipeQuerySchema, type Recipe } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { RecipesService, type RecipeRecord } from "./recipes.service.js";
import { parseOrBadRequest } from "./validation.js";

const RECIPE_NOT_FOUND = "Recipe not found";

function toRecipeResponse(recipe: RecipeRecord): Recipe {
  return {
    id: recipe.id,
    productId: recipe.productId,
    variantId: recipe.variantId,
    modifierOptionId: recipe.modifierOptionId,
    semiFinishedItemId: recipe.semiFinishedItemId,
    version: recipe.version,
    items: recipe.items.map((item) => ({ id: item.id, itemId: item.itemId, quantity: item.quantity, unitId: item.unitId, yieldPercent: item.yieldPercent })),
    createdAt: recipe.createdAt.toISOString(),
    updatedAt: recipe.updatedAt.toISOString(),
  };
}

@Controller("recipes")
export class RecipesController {
  constructor(private readonly recipesService: RecipesService) {}

  @Get()
  @RequirePermission("recipes.manage")
  async get(@Query() query: unknown): Promise<Recipe> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(GetRecipeQuerySchema, query);
    const recipe = await this.recipesService.get({ restaurantId: tenant.restaurantId, ...request });
    if (!recipe) throw new NotFoundException(RECIPE_NOT_FOUND);
    return toRecipeResponse(recipe);
  }

  @Put()
  @RequirePermission("recipes.manage")
  async createOrReplace(@Body() body: unknown): Promise<Recipe> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(CreateOrReplaceRecipeSchema, body);
    const recipe = await this.recipesService.createOrReplace({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toRecipeResponse(recipe);
  }

  @Delete()
  @RequirePermission("recipes.manage")
  async delete(@Query() query: unknown): Promise<{ deleted: true }> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(GetRecipeQuerySchema, query);
    await this.recipesService.delete({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return { deleted: true };
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
