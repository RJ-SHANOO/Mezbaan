import { Inject, Injectable } from "@nestjs/common";
import { blendWeightedAverageCost, money, type Money } from "@mezbaan/domain";
import { and, asc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE } from "./db.module.js";

export interface StockLevelRecord {
  id: string;
  branchId: string;
  storageLocationId: string;
  itemId: string;
  quantity: number;
  averageCostMinor: bigint | null;
  currency: string | null;
  updatedAt: Date;
}

export interface ApplyDeltaParams {
  restaurantId: string;
  branchId: string;
  storageLocationId: string;
  itemId: string;
  quantityDelta: number;
  /** The cost this movement's own units carry, if known — only
   * meaningful for an increase (quantityDelta > 0), folded into the
   * running weighted average. Ignored for a decrease, which is always
   * valued at the current average instead of whatever the caller sends. */
  unitCostMinor?: bigint;
  currency?: string;
}

export interface ApplyDeltaResult {
  /** What this specific movement should be snapshotted at on the ledger
   * row — see stock-ledger.ts's own docs for exactly which value this is
   * (the raw incoming cost for a costed increase, the current average
   * for everything else). Null only if this item has never had a costed
   * movement at this location at all. */
  unitCostMinor: bigint | null;
  currency: string | null;
  /** The resulting quantity after this delta — P3-12's negative-stock
   * flag check reads this rather than re-querying, since applyDelta
   * already has it in hand. */
  newQuantity: number;
}

export interface ListStockLevelsParams {
  restaurantId: string;
  branchId?: string;
  storageLocationId?: string;
  itemId?: string;
}

export interface RebuildStockLevelsParams {
  restaurantId: string;
  branchId?: string;
  /** false (the default): report discrepancies only, touch nothing — a
   * "verify" dry run. true: also overwrite stock_levels to match what the
   * ledger actually says. */
  apply?: boolean;
}

export interface StockLevelDiscrepancy {
  branchId: string;
  storageLocationId: string;
  itemId: string;
  storedQuantity: number;
  actualQuantity: number;
  storedCostMinor: bigint | null;
  actualCostMinor: bigint | null;
  currency: string | null;
}

export interface RebuildStockLevelsResult {
  checked: number;
  discrepancies: StockLevelDiscrepancy[];
  applied: boolean;
}

/**
 * P3-10/P3-11: stock_levels is a materialized cache of stock_ledger
 * (P3-09), never a second source of truth — see stock-levels.ts's own
 * docs for why this task needs one, unlike CreditCustomersService's
 * live-recomputed balance. `applyDelta` is called by StockLedgerService
 * inside the same transaction as every ledger insert, so the cache can
 * never observably lag behind the ledger under normal operation —
 * including its weighted-average unit cost, blended via packages/domain's
 * blendWeightedAverageCost (rule 5: money math never happens by hand).
 * `rebuild` exists for the abnormal case — replaying the whole ledger
 * from scratch (quantity AND cost together, since cost is path-dependent
 * on the order movements happened in, unlike a plain quantity sum) and
 * optionally correcting any drift this task's own name promises to catch.
 */
@Injectable()
export class StockLevelsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Must be called with the same `tx` as the ledger insert that caused this delta — never its own transaction. */
  async applyDelta(tx: Database, params: ApplyDeltaParams): Promise<ApplyDeltaResult> {
    const existingRows = await tx
      .select()
      .from(schema.stockLevels)
      .where(and(eq(schema.stockLevels.storageLocationId, params.storageLocationId), eq(schema.stockLevels.itemId, params.itemId)))
      .for("update");
    const existing = existingRows[0];

    const currentQuantity = existing?.quantity ?? 0;
    const currentAvgCost = toMoney(existing?.averageCostMinor ?? null, existing?.currency ?? null);

    let newAvgCost = currentAvgCost;
    let snapshotCost = currentAvgCost;

    if (params.quantityDelta > 0 && params.unitCostMinor !== undefined && params.currency !== undefined) {
      const incomingCost = money(params.unitCostMinor, params.currency);
      newAvgCost = blendWeightedAverageCost(currentQuantity, currentAvgCost, params.quantityDelta, incomingCost);
      snapshotCost = incomingCost; // the raw delivery cost, kept distinct from the blended average
    }

    const newQuantity = currentQuantity + params.quantityDelta;

    if (existing) {
      await tx
        .update(schema.stockLevels)
        .set({ quantity: newQuantity, averageCostMinor: newAvgCost?.amountMinor ?? null, currency: newAvgCost?.currency ?? null, updatedAt: new Date() })
        .where(eq(schema.stockLevels.id, existing.id));
    } else {
      await tx.insert(schema.stockLevels).values({
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        storageLocationId: params.storageLocationId,
        itemId: params.itemId,
        quantity: newQuantity,
        averageCostMinor: newAvgCost?.amountMinor ?? null,
        currency: newAvgCost?.currency ?? null,
      });
    }

    return { unitCostMinor: snapshotCost?.amountMinor ?? null, currency: snapshotCost?.currency ?? null, newQuantity };
  }

  async list(params: ListStockLevelsParams): Promise<StockLevelRecord[]> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.stockLevels)
        .where(
          and(
            params.branchId !== undefined ? eq(schema.stockLevels.branchId, params.branchId) : undefined,
            params.storageLocationId !== undefined ? eq(schema.stockLevels.storageLocationId, params.storageLocationId) : undefined,
            params.itemId !== undefined ? eq(schema.stockLevels.itemId, params.itemId) : undefined,
          ),
        ),
    );
  }

  /**
   * Replays every ledger row, oldest first, rebuilding each
   * (storageLocationId, itemId) pair's quantity and weighted-average cost
   * from nothing — enumerated from the ledger itself, not from
   * stock_levels' existing rows, so a pair the cache never learned about
   * (e.g. an old bug that skipped an applyDelta call) is still caught.
   * Deliberately no delete path: stock_ledger is append-only, so a pair
   * that ever appears there always still belongs in stock_levels — a
   * rebuild only ever has rows to add or correct, never remove.
   */
  async rebuild(params: RebuildStockLevelsParams): Promise<RebuildStockLevelsResult> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const ledgerRows = await tx
        .select()
        .from(schema.stockLedger)
        .where(params.branchId !== undefined ? eq(schema.stockLedger.branchId, params.branchId) : undefined)
        .orderBy(asc(schema.stockLedger.createdAt), asc(schema.stockLedger.id));

      interface ReplayState {
        branchId: string;
        storageLocationId: string;
        itemId: string;
        quantity: number;
        avgCost: Money | null;
      }
      const replayed = new Map<string, ReplayState>();
      for (const row of ledgerRows) {
        const key = `${row.storageLocationId}:${row.itemId}`;
        const state = replayed.get(key) ?? { branchId: row.branchId, storageLocationId: row.storageLocationId, itemId: row.itemId, quantity: 0, avgCost: null };
        if (row.quantityDelta > 0 && row.unitCostMinor !== null && row.currency !== null) {
          state.avgCost = blendWeightedAverageCost(state.quantity, state.avgCost, row.quantityDelta, money(row.unitCostMinor, row.currency));
        }
        state.quantity += row.quantityDelta;
        replayed.set(key, state);
      }

      const storedRows = await tx
        .select()
        .from(schema.stockLevels)
        .where(params.branchId !== undefined ? eq(schema.stockLevels.branchId, params.branchId) : undefined);
      const storedByKey = new Map(storedRows.map((row) => [`${row.storageLocationId}:${row.itemId}`, row]));

      const discrepancies: StockLevelDiscrepancy[] = [];
      for (const [key, state] of replayed) {
        const stored = storedByKey.get(key);
        const storedQuantity = stored?.quantity ?? 0;
        const storedCostMinor = stored?.averageCostMinor ?? null;
        const actualCostMinor = state.avgCost?.amountMinor ?? null;
        if (storedQuantity !== state.quantity || storedCostMinor !== actualCostMinor) {
          discrepancies.push({
            branchId: state.branchId,
            storageLocationId: state.storageLocationId,
            itemId: state.itemId,
            storedQuantity,
            actualQuantity: state.quantity,
            storedCostMinor,
            actualCostMinor,
            currency: state.avgCost?.currency ?? stored?.currency ?? null,
          });
        }
      }

      if (params.apply === true) {
        for (const state of replayed.values()) {
          const stored = storedByKey.get(`${state.storageLocationId}:${state.itemId}`);
          const values = {
            restaurantId: params.restaurantId,
            branchId: state.branchId,
            storageLocationId: state.storageLocationId,
            itemId: state.itemId,
            quantity: state.quantity,
            averageCostMinor: state.avgCost?.amountMinor ?? null,
            currency: state.avgCost?.currency ?? null,
          };
          if (stored) {
            await tx
              .update(schema.stockLevels)
              .set({ quantity: values.quantity, averageCostMinor: values.averageCostMinor, currency: values.currency, updatedAt: new Date() })
              .where(eq(schema.stockLevels.id, stored.id));
          } else {
            await tx.insert(schema.stockLevels).values(values);
          }
        }
      }

      return { checked: replayed.size, discrepancies, applied: params.apply === true };
    });
  }
}

function toMoney(amountMinor: bigint | null, currency: string | null): Money | null {
  return amountMinor !== null && currency !== null ? money(amountMinor, currency) : null;
}
