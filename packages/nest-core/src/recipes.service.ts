import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq, inArray, sql, type SQL } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface RecipeItemRecord {
  id: string;
  itemId: string;
  quantity: number;
  unitId: string;
  yieldPercent: number;
}

export interface RecipeRecord {
  id: string;
  productId: string | null;
  variantId: string | null;
  modifierOptionId: string | null;
  semiFinishedItemId: string | null;
  /** P3-19: bumped by createOrReplace every time this recipe's own lines
   * change — see recipes.ts's own docs for why this is a plain counter
   * rather than full history. */
  version: number;
  items: RecipeItemRecord[];
  createdAt: Date;
  updatedAt: Date;
}

export interface RecipeItemInputParams {
  itemId: string;
  quantity: number;
  unitId: string;
  yieldPercent?: number;
}

/** Exactly one of productId/variantId/modifierOptionId/semiFinishedItemId
 * identifies which recipe this call is about — see recipes.ts's own docs
 * for why a modifier option (P3-14) and a semi-finished inventory item
 * (P3-15, e.g. "Marinara Sauce" having its own recipe) are valid owners
 * too, same shape as a product/variant's own recipe. */
export interface RecipeOwnerParams {
  productId?: string;
  variantId?: string;
  modifierOptionId?: string;
  semiFinishedItemId?: string;
}

export interface CreateOrReplaceRecipeParams extends RecipeOwnerParams {
  restaurantId: string;
  actorUserId: string;
  items: RecipeItemInputParams[];
}

export interface GetRecipeParams extends RecipeOwnerParams {
  restaurantId: string;
}

export interface DeleteRecipeParams extends RecipeOwnerParams {
  restaurantId: string;
  actorUserId: string;
}

const PRODUCT_NOT_FOUND = "Product not found";
const VARIANT_NOT_FOUND = "Product variant not found";
const MODIFIER_OPTION_NOT_FOUND = "Modifier option not found";
const SEMI_FINISHED_ITEM_NOT_FOUND = "Inventory item not found";
const NOT_SEMI_FINISHED = "Only a semi-finished inventory item can own a recipe — this item is a raw, purchased ingredient";
const ITEM_NOT_FOUND = "Inventory item not found";
const UNIT_NOT_FOUND = "Unit not found";
const RECIPE_NOT_FOUND = "Recipe not found";
const EXACTLY_ONE_OWNER = "exactly one of productId, variantId, modifierOptionId or semiFinishedItemId must be given";
const SELF_REFERENCING_RECIPE = "a semi-finished item's recipe can't use itself as an ingredient";

/**
 * P3-13/P3-14/P3-15: what a product/variant, a modifier option (e.g.
 * "Extra Cheese" adding mozzarella on top of the base product's own
 * recipe), or a semi-finished inventory item (e.g. "Marinara Sauce" —
 * itself just an ordinary inventory_items row, see that table's own
 * docs) is made of. `createOrReplace` is the only write — a recipe has
 * at most one set of lines at any time (recipes.ts's own four partial
 * unique indexes), so "add an ingredient" and "edit a recipe" are both
 * just calling this again with the new full list; there is no per-line
 * CRUD, same "edit the whole thing at once" reasoning real recipe cards
 * work by. Deliberately not versioned (see recipes.ts's own docs) —
 * P3-19 decides how snapshotting actually works later. Summing a base
 * recipe with every selected modifier's own recipe, and recursively
 * expanding any semi-finished ingredient into its own recipe, is P3-17's
 * job, not this one — see recipes.ts's own docs for the one cycle check
 * this service *does* make (direct self-reference) versus the deeper
 * ones it deliberately leaves to whichever task actually walks the tree.
 */
@Injectable()
export class RecipesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async get(params: GetRecipeParams): Promise<RecipeRecord | null> {
    const ownerCondition = this.requireExactlyOneOwner(params);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const recipeRows = await tx.select().from(schema.recipes).where(ownerCondition);
      const recipe = recipeRows[0];
      if (!recipe) return null;

      const items = await tx.select().from(schema.recipeItems).where(eq(schema.recipeItems.recipeId, recipe.id));
      return { ...recipe, items };
    });
  }

  async createOrReplace(params: CreateOrReplaceRecipeParams): Promise<RecipeRecord> {
    const ownerCondition = this.requireExactlyOneOwner(params);
    if (params.semiFinishedItemId !== undefined && params.items.some((item) => item.itemId === params.semiFinishedItemId)) {
      throw new BadRequestException(SELF_REFERENCING_RECIPE);
    }

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      await this.requireOwnerExists(tx, params);

      const itemIds = [...new Set(params.items.map((item) => item.itemId))];
      const itemRows = await tx.select({ id: schema.inventoryItems.id }).from(schema.inventoryItems).where(inArray(schema.inventoryItems.id, itemIds));
      if (itemRows.length !== itemIds.length) throw new NotFoundException(ITEM_NOT_FOUND);

      const unitIds = [...new Set(params.items.map((item) => item.unitId))];
      const unitRows = await tx.select({ id: schema.units.id }).from(schema.units).where(inArray(schema.units.id, unitIds));
      if (unitRows.length !== unitIds.length) throw new NotFoundException(UNIT_NOT_FOUND);

      const existingRows = await tx.select().from(schema.recipes).where(ownerCondition);
      let recipe = existingRows[0];

      if (recipe) {
        await tx.delete(schema.recipeItems).where(eq(schema.recipeItems.recipeId, recipe.id));
        // P3-19: every createOrReplace call on an already-existing recipe is a
        // new edition — bumped here, the one place recipe_items actually changes.
        const updatedRows = await tx
          .update(schema.recipes)
          .set({ version: sql`${schema.recipes.version} + 1`, updatedAt: new Date() })
          .where(eq(schema.recipes.id, recipe.id))
          .returning();
        recipe = updatedRows[0]!;
      } else {
        const insertedRows = await tx
          .insert(schema.recipes)
          .values({
            restaurantId: params.restaurantId,
            productId: params.productId ?? null,
            variantId: params.variantId ?? null,
            modifierOptionId: params.modifierOptionId ?? null,
            semiFinishedItemId: params.semiFinishedItemId ?? null,
          })
          .returning();
        recipe = insertedRows[0]!;
      }

      const insertedItems = await tx
        .insert(schema.recipeItems)
        .values(
          params.items.map((item) => ({
            restaurantId: params.restaurantId,
            recipeId: recipe.id,
            itemId: item.itemId,
            quantity: item.quantity,
            unitId: item.unitId,
            yieldPercent: item.yieldPercent ?? 100,
          })),
        )
        .returning();

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "recipe.replaced",
          targetType: "recipe",
          targetId: recipe.id,
          metadata: {
            productId: recipe.productId,
            variantId: recipe.variantId,
            modifierOptionId: recipe.modifierOptionId,
            semiFinishedItemId: recipe.semiFinishedItemId,
            itemCount: insertedItems.length,
          },
        },
        tx,
      );
      return { ...recipe, items: insertedItems };
    });
  }

  async delete(params: DeleteRecipeParams): Promise<void> {
    const ownerCondition = this.requireExactlyOneOwner(params);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx.select().from(schema.recipes).where(ownerCondition);
      const recipe = rows[0];
      if (!recipe) throw new NotFoundException(RECIPE_NOT_FOUND);

      await tx.delete(schema.recipeItems).where(eq(schema.recipeItems.recipeId, recipe.id));
      await tx.delete(schema.recipes).where(eq(schema.recipes.id, recipe.id));

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "recipe.deleted", targetType: "recipe", targetId: recipe.id },
        tx,
      );
    });
  }

  private requireExactlyOneOwner(params: RecipeOwnerParams): SQL {
    const setCount = [params.productId, params.variantId, params.modifierOptionId, params.semiFinishedItemId].filter((v) => v !== undefined).length;
    if (setCount !== 1) throw new BadRequestException(EXACTLY_ONE_OWNER);

    if (params.productId !== undefined) return eq(schema.recipes.productId, params.productId);
    if (params.variantId !== undefined) return eq(schema.recipes.variantId, params.variantId);
    if (params.modifierOptionId !== undefined) return eq(schema.recipes.modifierOptionId, params.modifierOptionId);
    return eq(schema.recipes.semiFinishedItemId, params.semiFinishedItemId!);
  }

  private async requireOwnerExists(tx: Database, params: RecipeOwnerParams): Promise<void> {
    if (params.productId !== undefined) {
      const rows = await tx.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.id, params.productId));
      if (rows.length === 0) throw new NotFoundException(PRODUCT_NOT_FOUND);
    } else if (params.variantId !== undefined) {
      const rows = await tx.select({ id: schema.productVariants.id }).from(schema.productVariants).where(eq(schema.productVariants.id, params.variantId));
      if (rows.length === 0) throw new NotFoundException(VARIANT_NOT_FOUND);
    } else if (params.modifierOptionId !== undefined) {
      const rows = await tx.select({ id: schema.modifierOptions.id }).from(schema.modifierOptions).where(eq(schema.modifierOptions.id, params.modifierOptionId));
      if (rows.length === 0) throw new NotFoundException(MODIFIER_OPTION_NOT_FOUND);
    } else {
      const rows = await tx
        .select({ id: schema.inventoryItems.id, itemType: schema.inventoryItems.itemType })
        .from(schema.inventoryItems)
        .where(eq(schema.inventoryItems.id, params.semiFinishedItemId!));
      const item = rows[0];
      if (!item) throw new NotFoundException(SEMI_FINISHED_ITEM_NOT_FOUND);
      if (item.itemType !== "semi_finished") throw new BadRequestException(NOT_SEMI_FINISHED);
    }
  }
}
