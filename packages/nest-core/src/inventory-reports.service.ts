import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { add, money, scaleMoneyByQuantity, type Money } from "@mezbaan/domain";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { businessDateRangeToUtc } from "./business-date-range.js";
import { DATABASE } from "./db.module.js";
import type { MovementType } from "./stock-ledger.service.js";

export interface StockOnHandEntry {
  storageLocationId: string;
  itemId: string;
  quantity: number;
  averageCostMinor: bigint | null;
  currency: string | null;
  /** quantity × averageCostMinor — null only when this item has never
   * had a costed movement at this location, the same "no established
   * cost yet" state stock_levels.ts itself allows. */
  valueMinor: bigint | null;
}

export interface StockOnHandReport {
  branchId: string;
  entries: StockOnHandEntry[];
  currency: string | null;
  /** Sums only the entries that had an established cost — an uncosted
   * entry contributes nothing, the same documented understatement
   * P3-16's production costing already accepts, not a silent correctness
   * claim. */
  totalValueMinor: bigint;
}

export interface StockValuationByLocation {
  storageLocationId: string;
  valueMinor: bigint;
}

export interface StockValuationReport {
  branchId: string;
  currency: string | null;
  byLocation: StockValuationByLocation[];
  totalValueMinor: bigint;
}

export interface StockMovementSummaryEntry {
  movementType: MovementType;
  count: number;
  totalQuantityDelta: number;
}

export interface StockMovementReport {
  branchId: string;
  fromBusinessDate: string;
  toBusinessDate: string;
  byMovementType: StockMovementSummaryEntry[];
}

export interface FoodCostVarianceReport {
  branchId: string;
  fromBusinessDate: string;
  toBusinessDate: string;
  currency: string | null;
  /** What the period's sales should have cost per their own recipes —
   * sum of order_item_food_costs.costMinor (P3-19) for invoices in this
   * branch/period. */
  theoreticalCostMinor: bigint;
  /** The ledger-valued cost of ingredients actually deducted for sales
   * in the period (stock_ledger's "sale" rows) — see this method's own
   * docs for why this is, by construction, almost always close to
   * theoreticalCostMinor on its own. */
  actualSalesCostMinor: bigint;
  /** The ledger-valued cost of ad-hoc wastage in the period
   * (stock_ledger's "wastage" rows, P3-18/P3-28 both write this type). */
  actualWastageCostMinor: bigint;
  /** actualSalesCostMinor + actualWastageCostMinor. */
  actualCostMinor: bigint;
  /** actualCostMinor - theoreticalCostMinor — positive means more left
   * the stockroom than recipes predicted for what was sold (wastage,
   * over-portioning, shrinkage); see this method's own docs for the
   * deliberate scope choice behind this definition. */
  varianceMinor: bigint;
}

export interface WastageReportByReasonEntry {
  reasonCode: string;
  count: number;
  costMinor: bigint;
}

export interface WastageReport {
  branchId: string;
  fromBusinessDate: string;
  toBusinessDate: string;
  currency: string | null;
  /** Every "wastage" stock_ledger movement in the period (P3-18's
   * void-triggered wastage and P3-28's ad-hoc entries both write this
   * type) — the complete figure, same source P3-32's variance report
   * sums. */
  totalCostMinor: bigint;
  /** Reason-code breakdown covers P3-28's ad-hoc wastage_entries only —
   * a void-triggered wastage row's own reason lives on the order item's
   * voidReasonCode (P2-23), not broken down here. Documented gap, not a
   * silently incomplete total: `totalCostMinor` above already reflects
   * every source, this breakdown just can't attribute all of it by
   * reason yet. */
  byReasonCode: WastageReportByReasonEntry[];
}

export interface PurchaseReportBySupplierEntry {
  supplierId: string;
  valueMinor: bigint;
  noteCount: number;
}

export interface PurchaseReport {
  branchId: string;
  fromBusinessDate: string;
  toBusinessDate: string;
  currency: string | null;
  totalValueMinor: bigint;
  bySupplier: PurchaseReportBySupplierEntry[];
}

export interface SupplierActivityReport {
  supplierId: string;
  fromBusinessDate: string;
  toBusinessDate: string;
  currency: string | null;
  purchasedValueMinor: bigint;
  goodsReceivedNoteCount: number;
  /** purchase_return_items (P3-24) carries no cost field — stock
   * returns are deliberately tracked by quantity only, not value — so
   * this is a count/quantity figure, not a money one. */
  returnedQuantity: number;
  purchaseReturnCount: number;
}

const BRANCH_NOT_FOUND = "Branch not found";
const SUPPLIER_NOT_FOUND = "Supplier not found";

/**
 * P3-31: stock on hand, valuation and movement reports — api-reports' own
 * extension of P2-40's "basic pilot reports" to inventory, same "a slow
 * or broken report can never hold up a sale" process boundary. Stock on
 * hand/valuation are live snapshots of stock_levels (P3-10/11) — not a
 * stored report, since "what's on hand right now" is exactly what that
 * table already is; this just shapes and totals it per branch rather
 * than per (location, item) row. The movement report windows by business
 * day the same way SalesReportsService's own reports do (shared
 * `businessDateRangeToUtc`, extracted from that service's own private
 * helper since this is its first other caller), but spans an inclusive
 * `[fromBusinessDate, toBusinessDate]` range rather than a single day —
 * a stock movement report reasonably covers a week or a month, unlike
 * P2-40's strictly-daily sales summary.
 */
@Injectable()
export class InventoryReportsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async getStockOnHand(params: { restaurantId: string; branchId: string; storageLocationId?: string }): Promise<StockOnHandReport> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const locationRows = await tx.select({ id: schema.storageLocations.id }).from(schema.storageLocations).where(eq(schema.storageLocations.branchId, params.branchId));
      if (locationRows.length === 0) throw new NotFoundException(BRANCH_NOT_FOUND);
      const locationIds = new Set(locationRows.map((row) => row.id));
      if (params.storageLocationId !== undefined && !locationIds.has(params.storageLocationId)) throw new NotFoundException(BRANCH_NOT_FOUND);

      const levelRows = await tx.select().from(schema.stockLevels).where(eq(schema.stockLevels.branchId, params.branchId));
      const filtered = params.storageLocationId !== undefined ? levelRows.filter((row) => row.storageLocationId === params.storageLocationId) : levelRows;

      const entries: StockOnHandEntry[] = [];
      let total: Money | null = null;
      let currency: string | null = null;
      for (const row of filtered) {
        let valueMinor: bigint | null = null;
        if (row.averageCostMinor !== null && row.currency !== null) {
          const value = scaleMoneyByQuantity(money(row.averageCostMinor, row.currency), row.quantity);
          valueMinor = value.amountMinor;
          total = total ? add(total, value) : value;
          currency = row.currency;
        }
        entries.push({ storageLocationId: row.storageLocationId, itemId: row.itemId, quantity: row.quantity, averageCostMinor: row.averageCostMinor, currency: row.currency, valueMinor });
      }

      return { branchId: params.branchId, entries, currency, totalValueMinor: total?.amountMinor ?? 0n };
    });
  }

  async getStockValuation(params: { restaurantId: string; branchId: string }): Promise<StockValuationReport> {
    const onHand = await this.getStockOnHand(params);

    const totalsByLocation = new Map<string, Money | null>();
    for (const entry of onHand.entries) {
      if (entry.valueMinor === null || entry.currency === null) continue;
      const existing = totalsByLocation.get(entry.storageLocationId) ?? null;
      const value = money(entry.valueMinor, entry.currency);
      totalsByLocation.set(entry.storageLocationId, existing ? add(existing, value) : value);
    }

    const byLocation: StockValuationByLocation[] = [...totalsByLocation.entries()].map(([storageLocationId, value]) => ({ storageLocationId, valueMinor: value?.amountMinor ?? 0n }));

    return { branchId: params.branchId, currency: onHand.currency, byLocation, totalValueMinor: onHand.totalValueMinor };
  }

  async getStockMovementReport(params: { restaurantId: string; branchId: string; fromBusinessDate: string; toBusinessDate: string }): Promise<StockMovementReport> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const branchRows = await tx.select({ timezone: schema.branches.timezone }).from(schema.branches).where(eq(schema.branches.id, params.branchId));
      const branch = branchRows[0];
      if (!branch) throw new NotFoundException(BRANCH_NOT_FOUND);

      const { start, end } = businessDateRangeToUtc(params.fromBusinessDate, params.toBusinessDate, branch.timezone);

      const rows = await tx
        .select({ movementType: schema.stockLedger.movementType, quantityDelta: schema.stockLedger.quantityDelta })
        .from(schema.stockLedger)
        .where(and(eq(schema.stockLedger.branchId, params.branchId), gte(schema.stockLedger.createdAt, start), lt(schema.stockLedger.createdAt, end)));

      const byType = new Map<MovementType, { count: number; totalQuantityDelta: number }>();
      for (const row of rows) {
        const existing = byType.get(row.movementType) ?? { count: 0, totalQuantityDelta: 0 };
        existing.count += 1;
        existing.totalQuantityDelta += row.quantityDelta;
        byType.set(row.movementType, existing);
      }

      const byMovementType: StockMovementSummaryEntry[] = [...byType.entries()].map(([movementType, totals]) => ({ movementType, ...totals }));
      return { branchId: params.branchId, fromBusinessDate: params.fromBusinessDate, toBusinessDate: params.toBusinessDate, byMovementType };
    });
  }

  /**
   * P3-32: theoretical vs. actual food cost. "Theoretical" is what the
   * period's sales should have cost per their own recipes — the sum of
   * P3-19's own per-sale snapshots (order_item_food_costs.costMinor),
   * never recomputed here. "Actual" is scoped deliberately narrowly to
   * stock_ledger's "sale" and "wastage" movement types only — not a full
   * beginning+purchases-ending COGS reconstruction (which would need a
   * point-in-time replay of the whole ledger up to an arbitrary past
   * date, the same scale of work StockLevelsService.rebuild does for the
   * *current* moment only) and not "transfer"/"return" either, since
   * neither represents stock actually being consumed — a transfer just
   * moves it, a return sends it back intact.
   *
   * Because both halves are independently costed from the same current
   * weighted-average at the same moment (SalesStockDeductionService
   * reads it before writing, order_item_food_costs reads it the same
   * way), `actualSalesCostMinor` alone is already expected to sit very
   * close to `theoreticalCostMinor` in the ordinary case — small
   * differences are just independent per-item vs. per-ingredient
   * rounding, not a real signal. The actually useful number this report
   * surfaces is `varianceMinor`, which in practice is driven almost
   * entirely by `actualWastageCostMinor`: how much food cost was lost to
   * wastage beyond what the recipes themselves predicted for what sold.
   */
  async getFoodCostVarianceReport(params: { restaurantId: string; branchId: string; fromBusinessDate: string; toBusinessDate: string }): Promise<FoodCostVarianceReport> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const branchRows = await tx.select({ timezone: schema.branches.timezone }).from(schema.branches).where(eq(schema.branches.id, params.branchId));
      const branch = branchRows[0];
      if (!branch) throw new NotFoundException(BRANCH_NOT_FOUND);

      const { start, end } = businessDateRangeToUtc(params.fromBusinessDate, params.toBusinessDate, branch.timezone);
      let currency: string | null = null;

      const foodCostRows = await tx
        .select({ costMinor: schema.orderItemFoodCosts.costMinor, currency: schema.orderItemFoodCosts.currency })
        .from(schema.orderItemFoodCosts)
        .where(and(eq(schema.orderItemFoodCosts.branchId, params.branchId), gte(schema.orderItemFoodCosts.createdAt, start), lt(schema.orderItemFoodCosts.createdAt, end)));
      let theoretical: Money | null = null;
      for (const row of foodCostRows) {
        if (row.costMinor === null || row.currency === null) continue;
        const cost = money(row.costMinor, row.currency);
        theoretical = theoretical ? add(theoretical, cost) : cost;
        currency = row.currency;
      }

      const ledgerRows = await tx
        .select({ movementType: schema.stockLedger.movementType, quantityDelta: schema.stockLedger.quantityDelta, unitCostMinor: schema.stockLedger.unitCostMinor, currency: schema.stockLedger.currency })
        .from(schema.stockLedger)
        .where(and(eq(schema.stockLedger.branchId, params.branchId), gte(schema.stockLedger.createdAt, start), lt(schema.stockLedger.createdAt, end)));
      let actualSales: Money | null = null;
      let actualWastage: Money | null = null;
      for (const row of ledgerRows) {
        if (row.quantityDelta >= 0 || row.unitCostMinor === null || row.currency === null) continue;
        if (row.movementType !== "sale" && row.movementType !== "wastage") continue;
        const value = scaleMoneyByQuantity(money(row.unitCostMinor, row.currency), -row.quantityDelta);
        currency = row.currency;
        if (row.movementType === "sale") actualSales = actualSales ? add(actualSales, value) : value;
        else actualWastage = actualWastage ? add(actualWastage, value) : value;
      }

      const theoreticalCostMinor = theoretical?.amountMinor ?? 0n;
      const actualSalesCostMinor = actualSales?.amountMinor ?? 0n;
      const actualWastageCostMinor = actualWastage?.amountMinor ?? 0n;
      const actualCostMinor = actualSalesCostMinor + actualWastageCostMinor;

      return {
        branchId: params.branchId,
        fromBusinessDate: params.fromBusinessDate,
        toBusinessDate: params.toBusinessDate,
        currency,
        theoreticalCostMinor,
        actualSalesCostMinor,
        actualWastageCostMinor,
        actualCostMinor,
        varianceMinor: actualCostMinor - theoreticalCostMinor,
      };
    });
  }

  /**
   * P3-33: wastage report — the complete period total (every "wastage"
   * stock_ledger movement, same source P3-32 sums) plus a reason-code
   * breakdown sourced from wastage_entries (P3-28) only — see this
   * method's own docs for why a void-triggered wastage row isn't broken
   * down by reason here.
   */
  async getWastageReport(params: { restaurantId: string; branchId: string; fromBusinessDate: string; toBusinessDate: string }): Promise<WastageReport> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const branchRows = await tx.select({ timezone: schema.branches.timezone }).from(schema.branches).where(eq(schema.branches.id, params.branchId));
      const branch = branchRows[0];
      if (!branch) throw new NotFoundException(BRANCH_NOT_FOUND);

      const { start, end } = businessDateRangeToUtc(params.fromBusinessDate, params.toBusinessDate, branch.timezone);
      let currency: string | null = null;

      const ledgerRows = await tx
        .select({ quantityDelta: schema.stockLedger.quantityDelta, unitCostMinor: schema.stockLedger.unitCostMinor, currency: schema.stockLedger.currency })
        .from(schema.stockLedger)
        .where(and(eq(schema.stockLedger.branchId, params.branchId), eq(schema.stockLedger.movementType, "wastage"), gte(schema.stockLedger.createdAt, start), lt(schema.stockLedger.createdAt, end)));
      let total: Money | null = null;
      for (const row of ledgerRows) {
        if (row.quantityDelta >= 0 || row.unitCostMinor === null || row.currency === null) continue;
        const value = scaleMoneyByQuantity(money(row.unitCostMinor, row.currency), -row.quantityDelta);
        total = total ? add(total, value) : value;
        currency = row.currency;
      }

      const entryRows = await tx
        .select({ reasonCode: schema.wastageEntries.reasonCode, costMinor: schema.wastageEntries.costMinor, currency: schema.wastageEntries.currency })
        .from(schema.wastageEntries)
        .where(and(eq(schema.wastageEntries.branchId, params.branchId), gte(schema.wastageEntries.createdAt, start), lt(schema.wastageEntries.createdAt, end)));
      const byReason = new Map<string, { count: number; costMinor: bigint }>();
      for (const row of entryRows) {
        const existing = byReason.get(row.reasonCode) ?? { count: 0, costMinor: 0n };
        existing.count += 1;
        existing.costMinor += row.costMinor ?? 0n;
        byReason.set(row.reasonCode, existing);
        if (currency === null && row.currency !== null) currency = row.currency;
      }

      return {
        branchId: params.branchId,
        fromBusinessDate: params.fromBusinessDate,
        toBusinessDate: params.toBusinessDate,
        currency,
        totalCostMinor: total?.amountMinor ?? 0n,
        byReasonCode: [...byReason.entries()].map(([reasonCode, totals]) => ({ reasonCode, ...totals })),
      };
    });
  }

  /** P3-33: purchasing activity in a period, broken down by supplier —
   * sourced from goods_received_notes/items (P3-22, what was actually
   * accepted and at what invoiced cost) joined through purchase_orders
   * for supplierId, not from stock_ledger's own "purchase" rows (which
   * carry no supplier reference at all). */
  async getPurchaseReport(params: { restaurantId: string; branchId: string; fromBusinessDate: string; toBusinessDate: string }): Promise<PurchaseReport> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const branchRows = await tx.select({ timezone: schema.branches.timezone }).from(schema.branches).where(eq(schema.branches.id, params.branchId));
      const branch = branchRows[0];
      if (!branch) throw new NotFoundException(BRANCH_NOT_FOUND);

      const { start, end } = businessDateRangeToUtc(params.fromBusinessDate, params.toBusinessDate, branch.timezone);

      const noteRows = await tx
        .select({ id: schema.goodsReceivedNotes.id, purchaseOrderId: schema.goodsReceivedNotes.purchaseOrderId })
        .from(schema.goodsReceivedNotes)
        .where(and(eq(schema.goodsReceivedNotes.branchId, params.branchId), gte(schema.goodsReceivedNotes.createdAt, start), lt(schema.goodsReceivedNotes.createdAt, end)));
      if (noteRows.length === 0) return { branchId: params.branchId, fromBusinessDate: params.fromBusinessDate, toBusinessDate: params.toBusinessDate, currency: null, totalValueMinor: 0n, bySupplier: [] };

      const purchaseOrderRows = await tx
        .select({ id: schema.purchaseOrders.id, supplierId: schema.purchaseOrders.supplierId })
        .from(schema.purchaseOrders)
        .where(inArray(schema.purchaseOrders.id, [...new Set(noteRows.map((row) => row.purchaseOrderId))]));
      const supplierByPoId = new Map(purchaseOrderRows.map((row) => [row.id, row.supplierId]));

      const itemRows = await tx
        .select({ goodsReceivedNoteId: schema.goodsReceivedNoteItems.goodsReceivedNoteId, deliveredQuantity: schema.goodsReceivedNoteItems.deliveredQuantity, rejectedQuantity: schema.goodsReceivedNoteItems.rejectedQuantity, invoicedUnitCostMinor: schema.goodsReceivedNoteItems.invoicedUnitCostMinor, currency: schema.goodsReceivedNoteItems.currency })
        .from(schema.goodsReceivedNoteItems)
        .where(inArray(schema.goodsReceivedNoteItems.goodsReceivedNoteId, noteRows.map((row) => row.id)));
      const poIdByNoteId = new Map(noteRows.map((row) => [row.id, row.purchaseOrderId]));

      let currency: string | null = null;
      let total: Money | null = null;
      const bySupplier = new Map<string, { value: Money | null; noteIds: Set<string> }>();
      for (const item of itemRows) {
        const accepted = item.deliveredQuantity - item.rejectedQuantity;
        if (accepted === 0) continue;
        const value = scaleMoneyByQuantity(money(item.invoicedUnitCostMinor, item.currency), accepted);
        total = total ? add(total, value) : value;
        currency = item.currency;

        const poId = poIdByNoteId.get(item.goodsReceivedNoteId);
        const supplierId = poId !== undefined ? supplierByPoId.get(poId) : undefined;
        if (supplierId === undefined) continue;
        const existing = bySupplier.get(supplierId) ?? { value: null, noteIds: new Set<string>() };
        existing.value = existing.value ? add(existing.value, value) : value;
        existing.noteIds.add(item.goodsReceivedNoteId);
        bySupplier.set(supplierId, existing);
      }

      const bySupplierList: PurchaseReportBySupplierEntry[] = [...bySupplier.entries()].map(([supplierId, entry]) => ({
        supplierId,
        valueMinor: entry.value?.amountMinor ?? 0n,
        noteCount: entry.noteIds.size,
      }));

      return { branchId: params.branchId, fromBusinessDate: params.fromBusinessDate, toBusinessDate: params.toBusinessDate, currency, totalValueMinor: total?.amountMinor ?? 0n, bySupplier: bySupplierList };
    });
  }

  /** P3-33: one supplier's own activity across every branch, not scoped
   * to one — a supplier serves a restaurant, not just one of its
   * branches (suppliers.ts itself is restaurant-scoped, not branch-
   * scoped). Pairs with P3-25's own `GET /suppliers/:id/ledger/balance`
   * for the current outstanding balance — deliberately not duplicated
   * here, since that endpoint already exists and this service has no
   * other reason to depend on SupplierLedgerService. */
  async getSupplierActivityReport(params: { restaurantId: string; supplierId: string; fromBusinessDate: string; toBusinessDate: string }): Promise<SupplierActivityReport> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const supplierRows = await tx.select({ id: schema.suppliers.id }).from(schema.suppliers).where(eq(schema.suppliers.id, params.supplierId));
      if (supplierRows.length === 0) throw new NotFoundException(SUPPLIER_NOT_FOUND);

      // No single branch's timezone applies to a cross-branch supplier
      // report — business dates here are interpreted as plain UTC
      // calendar days, a documented simplification for this one report.
      const start = new Date(`${params.fromBusinessDate}T00:00:00Z`);
      const endExclusive = new Date(`${params.toBusinessDate}T00:00:00Z`);
      endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);

      const poRows = await tx.select({ id: schema.purchaseOrders.id }).from(schema.purchaseOrders).where(and(eq(schema.purchaseOrders.restaurantId, params.restaurantId), eq(schema.purchaseOrders.supplierId, params.supplierId)));
      const poIds = new Set(poRows.map((row) => row.id));

      let currency: string | null = null;
      let purchasedValue: Money | null = null;
      let goodsReceivedNoteCount = 0;
      if (poIds.size > 0) {
        const noteRows = await tx
          .select({ id: schema.goodsReceivedNotes.id, purchaseOrderId: schema.goodsReceivedNotes.purchaseOrderId })
          .from(schema.goodsReceivedNotes)
          .where(and(inArray(schema.goodsReceivedNotes.purchaseOrderId, [...poIds]), gte(schema.goodsReceivedNotes.createdAt, start), lt(schema.goodsReceivedNotes.createdAt, endExclusive)));
        goodsReceivedNoteCount = noteRows.length;

        if (noteRows.length > 0) {
          const itemRows = await tx
            .select({ deliveredQuantity: schema.goodsReceivedNoteItems.deliveredQuantity, rejectedQuantity: schema.goodsReceivedNoteItems.rejectedQuantity, invoicedUnitCostMinor: schema.goodsReceivedNoteItems.invoicedUnitCostMinor, currency: schema.goodsReceivedNoteItems.currency })
            .from(schema.goodsReceivedNoteItems)
            .where(inArray(schema.goodsReceivedNoteItems.goodsReceivedNoteId, noteRows.map((row) => row.id)));
          for (const item of itemRows) {
            const accepted = item.deliveredQuantity - item.rejectedQuantity;
            if (accepted === 0) continue;
            const value = scaleMoneyByQuantity(money(item.invoicedUnitCostMinor, item.currency), accepted);
            purchasedValue = purchasedValue ? add(purchasedValue, value) : value;
            currency = item.currency;
          }
        }
      }

      let returnedQuantity = 0;
      let purchaseReturnCount = 0;
      if (poIds.size > 0) {
        const returnRows = await tx
          .select({ id: schema.purchaseReturns.id })
          .from(schema.purchaseReturns)
          .where(and(inArray(schema.purchaseReturns.purchaseOrderId, [...poIds]), gte(schema.purchaseReturns.createdAt, start), lt(schema.purchaseReturns.createdAt, endExclusive)));
        purchaseReturnCount = returnRows.length;

        if (returnRows.length > 0) {
          const returnItemRows = await tx.select({ quantity: schema.purchaseReturnItems.quantity }).from(schema.purchaseReturnItems).where(inArray(schema.purchaseReturnItems.purchaseReturnId, returnRows.map((row) => row.id)));
          returnedQuantity = returnItemRows.reduce((sum, row) => sum + row.quantity, 0);
        }
      }

      return {
        supplierId: params.supplierId,
        fromBusinessDate: params.fromBusinessDate,
        toBusinessDate: params.toBusinessDate,
        currency,
        purchasedValueMinor: purchasedValue?.amountMinor ?? 0n,
        goodsReceivedNoteCount,
        returnedQuantity,
        purchaseReturnCount,
      };
    });
  }
}
