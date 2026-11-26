import { BadRequestException } from "@nestjs/common";
import { add, convertQuantity, money, requiredRawQuantity, scaleMoneyByQuantity, type Money } from "@mezbaan/domain";
import { eq, and, inArray, or } from "drizzle-orm";
import { schema, type Database } from "@mezbaan/db";
import { convertItemQuantityToBaseUnit } from "./item-quantity-conversion.js";
import type { RecipesService } from "./recipes.service.js";
import type { StockLevelsService } from "./stock-levels.service.js";

export interface SoldLineModifier {
  modifierOptionId: string;
  quantity: number;
}

export interface SoldLine {
  productId: string | null;
  variantId: string | null;
  quantity: number;
  modifiers: SoldLineModifier[];
}

export interface ExpandedLineIngredients {
  required: Map<string, number>;
  /** The line's own *base* recipe (by productId/variantId) only — null
   * when the item had no base recipe configured at all. A modifier's own
   * recipe (if any) still contributes to `required` but is never reported
   * here — see order-item-food-costs.ts's own docs for why a sale only
   * stamps one recipe id/version per item. */
  baseRecipeId: string | null;
  baseRecipeVersion: number | null;
}

/**
 * Shared by SalesStockDeductionService (P3-17), VoidsService and
 * RefundsService (P3-18) — all three need the exact same "what ingredients,
 * in their own base units, does this one sold line actually require"
 * computation: the base recipe (by productId or variantId, whichever the
 * line carries) combined with every selected modifier's own recipe
 * (P3-14), per recipes.service.ts's own docs. Returns a plain
 * itemId -> quantity map for one line; callers that need to combine
 * several lines (an invoice's worth, in SalesStockDeductionService's case)
 * sum the maps themselves.
 *
 * Deliberately does not recursively expand a semi-finished ingredient into
 * its own recipe — see SalesStockDeductionService's own docs for why
 * (a semi-finished item already has real stock of its own from P3-16's
 * production batches; expanding again here would double-count).
 */
export async function expandLineIngredients(tx: Database, recipesService: RecipesService, restaurantId: string, line: SoldLine): Promise<ExpandedLineIngredients> {
  const required = new Map<string, number>();
  const add = (itemId: string, quantity: number) => required.set(itemId, (required.get(itemId) ?? 0) + quantity);

  const baseRecipe = line.productId
    ? await recipesService.get({ restaurantId, productId: line.productId })
    : line.variantId
      ? await recipesService.get({ restaurantId, variantId: line.variantId })
      : null;

  if (baseRecipe) {
    for (const recipeLine of baseRecipe.items) {
      const neededInLineUnit = recipeLine.quantity * line.quantity;
      const rawInLineUnit = requiredRawQuantity(neededInLineUnit, recipeLine.yieldPercent);
      const rawInBaseUnit = await convertItemQuantityToBaseUnit(tx, recipeLine.itemId, rawInLineUnit, recipeLine.unitId);
      add(recipeLine.itemId, rawInBaseUnit);
    }
  }

  for (const modifier of line.modifiers) {
    const modifierRecipe = await recipesService.get({ restaurantId, modifierOptionId: modifier.modifierOptionId });
    if (!modifierRecipe) continue;

    for (const recipeLine of modifierRecipe.items) {
      const neededInLineUnit = recipeLine.quantity * modifier.quantity * line.quantity;
      const rawInLineUnit = requiredRawQuantity(neededInLineUnit, recipeLine.yieldPercent);
      const rawInBaseUnit = await convertItemQuantityToBaseUnit(tx, recipeLine.itemId, rawInLineUnit, recipeLine.unitId);
      add(recipeLine.itemId, rawInBaseUnit);
    }
  }

  return { required, baseRecipeId: baseRecipe?.id ?? null, baseRecipeVersion: baseRecipe?.version ?? null };
}

export interface InvoiceLineInput extends SoldLine {
  orderItemId: string;
}

export interface ExpandedInvoiceLine {
  orderItemId: string;
  required: Map<string, number>;
  baseRecipeId: string | null;
  baseRecipeVersion: number | null;
}

export interface ExpandedInvoiceIngredients {
  perItem: ExpandedInvoiceLine[];
  /** Every line's `required` map, summed together — what
   * SalesStockDeductionService actually writes to stock_ledger. */
  totalRequired: Map<string, number>;
}

/**
 * P3-42: the set-based sibling of `expandLineIngredients` — computes the
 * exact same thing for every line on an invoice at once, in a handful of
 * queries total instead of several per line (a recipe lookup, a modifier
 * recipe lookup per selected modifier, and an item+conversion lookup per
 * recipe line, all repeated for every item on the invoice). Fetches every
 * recipe, recipe line, inventory item and unit conversion this invoice
 * could possibly need up front, then replays `expandLineIngredients`'s own
 * per-line math (requiredRawQuantity + convertQuantity) purely in memory —
 * same output, same rounding, just not one round trip per line.
 */
export async function expandInvoiceIngredientsBatch(tx: Database, restaurantId: string, lines: InvoiceLineInput[]): Promise<ExpandedInvoiceIngredients> {
  const productIds = [...new Set(lines.map((line) => line.productId).filter((id): id is string => id !== null))];
  const variantIds = [...new Set(lines.map((line) => line.variantId).filter((id): id is string => id !== null))];
  const modifierOptionIds = [...new Set(lines.flatMap((line) => line.modifiers.map((modifier) => modifier.modifierOptionId)))];

  const ownerConditions = [
    productIds.length > 0 ? inArray(schema.recipes.productId, productIds) : undefined,
    variantIds.length > 0 ? inArray(schema.recipes.variantId, variantIds) : undefined,
    modifierOptionIds.length > 0 ? inArray(schema.recipes.modifierOptionId, modifierOptionIds) : undefined,
  ].filter((condition): condition is NonNullable<typeof condition> => condition !== undefined);

  const recipeRows = ownerConditions.length === 0 ? [] : await tx.select().from(schema.recipes).where(and(eq(schema.recipes.restaurantId, restaurantId), or(...ownerConditions)));

  const recipeByProductId = new Map(recipeRows.filter((recipe) => recipe.productId !== null).map((recipe) => [recipe.productId as string, recipe]));
  const recipeByVariantId = new Map(recipeRows.filter((recipe) => recipe.variantId !== null).map((recipe) => [recipe.variantId as string, recipe]));
  const recipeByModifierOptionId = new Map(recipeRows.filter((recipe) => recipe.modifierOptionId !== null).map((recipe) => [recipe.modifierOptionId as string, recipe]));

  const recipeIds = recipeRows.map((recipe) => recipe.id);
  const recipeItemRows = recipeIds.length === 0 ? [] : await tx.select().from(schema.recipeItems).where(inArray(schema.recipeItems.recipeId, recipeIds));
  const recipeItemsByRecipeId = new Map<string, (typeof recipeItemRows)[number][]>();
  for (const recipeItem of recipeItemRows) {
    const list = recipeItemsByRecipeId.get(recipeItem.recipeId) ?? [];
    list.push(recipeItem);
    recipeItemsByRecipeId.set(recipeItem.recipeId, list);
  }

  const ingredientItemIds = [...new Set(recipeItemRows.map((recipeItem) => recipeItem.itemId))];
  const ingredientItemRows =
    ingredientItemIds.length === 0
      ? []
      : await tx.select({ id: schema.inventoryItems.id, baseUnitId: schema.inventoryItems.baseUnitId }).from(schema.inventoryItems).where(inArray(schema.inventoryItems.id, ingredientItemIds));
  const baseUnitIdByItemId = new Map(ingredientItemRows.map((row) => [row.id, row.baseUnitId]));

  const conversionRows =
    ingredientItemIds.length === 0 ? [] : await tx.select().from(schema.inventoryItemUnitConversions).where(inArray(schema.inventoryItemUnitConversions.itemId, ingredientItemIds));
  const conversionFactorsByItemId = new Map<string, Map<string, number>>();
  for (const conversion of conversionRows) {
    const factors = conversionFactorsByItemId.get(conversion.itemId) ?? new Map<string, number>();
    factors.set(conversion.unitId, conversion.factorToBaseUnit);
    conversionFactorsByItemId.set(conversion.itemId, factors);
  }

  const convertToBaseUnit = (itemId: string, quantity: number, fromUnitId: string): number => {
    const baseUnitId = baseUnitIdByItemId.get(itemId);
    if (!baseUnitId) throw new BadRequestException(`expandInvoiceIngredientsBatch: inventory item ${itemId} referenced by a recipe line was not found`);
    try {
      return convertQuantity(quantity, fromUnitId, baseUnitId, baseUnitId, conversionFactorsByItemId.get(itemId) ?? new Map());
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "Couldn't convert this line's unit to the item's own base unit");
    }
  };

  const perItem: ExpandedInvoiceLine[] = [];
  const totalRequired = new Map<string, number>();
  const addTotal = (itemId: string, quantity: number) => totalRequired.set(itemId, (totalRequired.get(itemId) ?? 0) + quantity);

  for (const line of lines) {
    const required = new Map<string, number>();
    const addRequired = (itemId: string, quantity: number) => required.set(itemId, (required.get(itemId) ?? 0) + quantity);

    const baseRecipe = line.productId ? recipeByProductId.get(line.productId) : line.variantId ? recipeByVariantId.get(line.variantId) : undefined;

    if (baseRecipe) {
      for (const recipeLine of recipeItemsByRecipeId.get(baseRecipe.id) ?? []) {
        const neededInLineUnit = recipeLine.quantity * line.quantity;
        const rawInLineUnit = requiredRawQuantity(neededInLineUnit, recipeLine.yieldPercent);
        addRequired(recipeLine.itemId, convertToBaseUnit(recipeLine.itemId, rawInLineUnit, recipeLine.unitId));
      }
    }

    for (const modifier of line.modifiers) {
      const modifierRecipe = recipeByModifierOptionId.get(modifier.modifierOptionId);
      if (!modifierRecipe) continue;
      for (const recipeLine of recipeItemsByRecipeId.get(modifierRecipe.id) ?? []) {
        const neededInLineUnit = recipeLine.quantity * modifier.quantity * line.quantity;
        const rawInLineUnit = requiredRawQuantity(neededInLineUnit, recipeLine.yieldPercent);
        addRequired(recipeLine.itemId, convertToBaseUnit(recipeLine.itemId, rawInLineUnit, recipeLine.unitId));
      }
    }

    for (const [itemId, quantity] of required) addTotal(itemId, quantity);
    perItem.push({ orderItemId: line.orderItemId, required, baseRecipeId: baseRecipe?.id ?? null, baseRecipeVersion: baseRecipe?.version ?? null });
  }

  return { perItem, totalRequired };
}

/**
 * P3-42: the set-based sibling of `computeLineCost` — reads every
 * required ingredient's current stock_levels row in one query instead of
 * one per ingredient, then prices each line purely in memory. Same
 * read-only, pre-deduction timing guarantee as `computeLineCost` (a
 * decrease never changes the average, so it doesn't matter that this
 * runs before the matching stock_ledger writes).
 */
export async function computeInvoiceLineCostsBatch(
  tx: Database,
  storageLocationId: string,
  perItem: ExpandedInvoiceLine[],
): Promise<Map<string, Money | null>> {
  const allItemIds = [...new Set(perItem.flatMap((line) => [...line.required.keys()]))];
  const levelRows =
    allItemIds.length === 0
      ? []
      : await tx
          .select({ itemId: schema.stockLevels.itemId, averageCostMinor: schema.stockLevels.averageCostMinor, currency: schema.stockLevels.currency })
          .from(schema.stockLevels)
          .where(and(eq(schema.stockLevels.storageLocationId, storageLocationId), inArray(schema.stockLevels.itemId, allItemIds)));
  const levelByItemId = new Map(levelRows.map((row) => [row.itemId, row]));

  const costByOrderItemId = new Map<string, Money | null>();
  for (const line of perItem) {
    let total: Money | null = null;
    for (const [itemId, quantity] of line.required) {
      if (quantity === 0) continue;
      const level = levelByItemId.get(itemId);
      if (!level || level.averageCostMinor === null || level.currency === null) continue;
      const lineCost = scaleMoneyByQuantity(money(level.averageCostMinor, level.currency), quantity);
      total = total ? add(total, lineCost) : lineCost;
    }
    costByOrderItemId.set(line.orderItemId, total);
  }
  return costByOrderItemId;
}

/**
 * P3-19: prices a line's own ingredient requirements at whatever each
 * ingredient's weighted-average cost already is right now
 * (stock_levels.averageCostMinor) — read-only, no write. Safe to call
 * before the matching stock_ledger deduction happens: a decrease never
 * changes the average (StockLevelsService.applyDelta only blends on an
 * increase), so reading it here first and writing the actual ledger rows
 * afterward can never observe a different number. An ingredient with no
 * established cost yet contributes zero rather than failing — the same
 * documented understatement P3-16's production costing already accepts.
 * Returns null currency/zero-with-no-currency only when nothing in
 * `required` had any cost at all (vs. a genuine zero total).
 */
export async function computeLineCost(tx: Database, stockLevelsService: StockLevelsService, restaurantId: string, storageLocationId: string, required: Map<string, number>): Promise<Money | null> {
  let total: Money | null = null;
  for (const [itemId, quantity] of required) {
    if (quantity === 0) continue;
    const levels = await stockLevelsService.list({ restaurantId, storageLocationId, itemId });
    const level = levels[0];
    if (!level || level.averageCostMinor === null || level.currency === null) continue;

    const lineCost = scaleMoneyByQuantity(money(level.averageCostMinor, level.currency), quantity);
    total = total ? add(total, lineCost) : lineCost;
  }
  return total;
}

/**
 * P3-17/P3-18: the one storage location a sale's (or a void's/refund's
 * compensating) automatic stock movement uses for a given branch — see
 * storage-locations.ts's own docs for why this is a single per-branch flag
 * rather than per-product routing. Null when the branch hasn't configured
 * one — every caller treats that as "skip, don't block" (rule 14), never
 * an error.
 */
export async function findDefaultSaleDeductionLocation(tx: Database, branchId: string): Promise<{ id: string } | null> {
  const rows = await tx
    .select({ id: schema.storageLocations.id })
    .from(schema.storageLocations)
    .where(and(eq(schema.storageLocations.branchId, branchId), eq(schema.storageLocations.isSaleDeductionDefault, true)));
  return rows[0] ?? null;
}
