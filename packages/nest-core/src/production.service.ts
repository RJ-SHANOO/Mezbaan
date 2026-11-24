import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { add, money, requiredRawQuantity, scaleMoneyByQuantity, type Money } from "@mezbaan/domain";
import { inArray } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE } from "./db.module.js";
import { convertItemQuantityToBaseUnit } from "./item-quantity-conversion.js";
import { RecipesService } from "./recipes.service.js";
import { StockLedgerService, type StockMovementRecord } from "./stock-ledger.service.js";

export interface RecordProductionBatchParams {
  restaurantId: string;
  actorUserId: string;
  semiFinishedItemId: string;
  /** In the semi-finished item's own base unit — same convention every
   * stock_ledger entry already uses, see that table's own docs. */
  batchQuantity: number;
  consumptionStorageLocationId: string;
  outputStorageLocationId: string;
  note?: string;
}

export interface ProductionBatchResult {
  productionBatchId: string;
  consumed: StockMovementRecord[];
  produced: StockMovementRecord;
}

const NO_RECIPE = "This item has no recipe defined — nothing to produce it from";
const BATCH_QUANTITY_POSITIVE = "batchQuantity must be positive";
const CROSS_BRANCH_PRODUCTION =
  "consumption and output storage locations must be in the same branch — producing from one branch's stock into another branch's is a transfer, not a production batch";

/**
 * P3-16: runs a production batch — consumes a semi-finished item's own
 * recipe (P3-13/P3-15), scaled by how much is being produced, and adds
 * the finished stock. The first real consumer of stock_ledger's
 * "production" movement type (P3-09 built the enum value with no caller
 * until now). Everything happens inside one transaction via
 * StockLedgerService.recordMovementInTx — every ingredient deduction and
 * the one finished-stock increase commit together or not at all.
 *
 * The produced stock's own unit cost is derived, not supplied: the sum
 * of what each consumed ingredient was actually valued at (its own
 * current weighted average, same as any other decrease — P3-11),
 * divided by batchQuantity. If any ingredient had no established cost
 * yet (null), its contribution is treated as zero rather than failing
 * the batch — a documented understatement, not a silent correctness
 * claim: a sauce made partly from a never-yet-purchased-with-a-recorded-
 * cost ingredient will show a lower cost than it actually took.
 *
 * Only a *direct* self-reference in the recipe is guarded against
 * (RecipesService.createOrReplace) — a deeper cycle (sauce A uses sauce
 * B, sauce B uses sauce A) is not detected here either, and would recurse
 * forever if this service ever expanded a semi-finished ingredient's own
 * recipe automatically. It doesn't: a recipe line that happens to name
 * another semi-finished item is deducted as *raw stock of that item*
 * (its own produced batches, not an on-the-fly recipe expansion) — which
 * is exactly why a batch of the sub-ingredient has to be produced and in
 * stock first, same as a real kitchen.
 */
@Injectable()
export class ProductionService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly recipesService: RecipesService,
    private readonly stockLedgerService: StockLedgerService,
  ) {}

  async recordBatch(params: RecordProductionBatchParams): Promise<ProductionBatchResult> {
    if (params.batchQuantity <= 0) throw new BadRequestException(BATCH_QUANTITY_POSITIVE);

    const recipe = await this.recipesService.get({ restaurantId: params.restaurantId, semiFinishedItemId: params.semiFinishedItemId });
    if (!recipe) throw new NotFoundException(NO_RECIPE);

    const productionBatchId = randomUUID();

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      await this.requireSameBranch(tx, params.consumptionStorageLocationId, params.outputStorageLocationId);

      const consumed: StockMovementRecord[] = [];
      let totalCost: Money | null = null;

      for (const line of recipe.items) {
        const neededInLineUnit = line.quantity * params.batchQuantity;
        const rawInLineUnit = requiredRawQuantity(neededInLineUnit, line.yieldPercent);
        const rawInBaseUnit = await convertItemQuantityToBaseUnit(tx, line.itemId, rawInLineUnit, line.unitId);

        const movement = await this.stockLedgerService.recordMovementInTx(tx, {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          storageLocationId: params.consumptionStorageLocationId,
          itemId: line.itemId,
          movementType: "production",
          quantityDelta: -rawInBaseUnit,
          productionBatchId,
          note: params.note,
        });
        consumed.push(movement);

        if (movement.unitCostMinor !== null && movement.currency !== null) {
          const lineCost = scaleMoneyByQuantity(money(movement.unitCostMinor, movement.currency), rawInBaseUnit);
          totalCost = totalCost ? add(totalCost, lineCost) : lineCost;
        }
      }

      const outputCost = totalCost ? scaleMoneyByQuantity(totalCost, 1 / params.batchQuantity) : null;
      const produced = await this.stockLedgerService.recordMovementInTx(tx, {
        restaurantId: params.restaurantId,
        actorUserId: params.actorUserId,
        storageLocationId: params.outputStorageLocationId,
        itemId: params.semiFinishedItemId,
        movementType: "production",
        quantityDelta: params.batchQuantity,
        productionBatchId,
        unitCostMinor: outputCost?.amountMinor,
        currency: outputCost?.currency,
        note: params.note,
      });

      return { productionBatchId, consumed, produced };
    });
  }

  /** Same same-branch guard as StockLedgerService.recordTransfer's
   * CROSS_BRANCH_TRANSFER check — a production batch physically happens
   * within one branch's kitchen, same as a transfer isn't allowed to
   * silently cross branches either. */
  private async requireSameBranch(tx: Database, consumptionStorageLocationId: string, outputStorageLocationId: string): Promise<void> {
    const rows = await tx
      .select({ id: schema.storageLocations.id, branchId: schema.storageLocations.branchId })
      .from(schema.storageLocations)
      .where(inArray(schema.storageLocations.id, [consumptionStorageLocationId, outputStorageLocationId]));

    const consumption = rows.find((row) => row.id === consumptionStorageLocationId);
    const output = rows.find((row) => row.id === outputStorageLocationId);
    if (!consumption) throw new NotFoundException("Consumption storage location not found");
    if (!output) throw new NotFoundException("Output storage location not found");
    if (consumption.branchId !== output.branchId) throw new BadRequestException(CROSS_BRANCH_PRODUCTION);
  }
}
