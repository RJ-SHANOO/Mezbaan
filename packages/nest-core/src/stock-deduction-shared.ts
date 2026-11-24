import { add, money, requiredRawQuantity, scaleMoneyByQuantity, type Money } from "@mezbaan/domain";
import { eq, and } from "drizzle-orm";
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
