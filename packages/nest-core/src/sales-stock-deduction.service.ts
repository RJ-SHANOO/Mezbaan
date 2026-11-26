import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE } from "./db.module.js";
import { StockLedgerService, type StockMovementRecord } from "./stock-ledger.service.js";
import { computeInvoiceLineCostsBatch, expandInvoiceIngredientsBatch, findDefaultSaleDeductionLocation } from "./stock-deduction-shared.js";

export interface DeductStockForInvoiceParams {
  restaurantId: string;
  invoiceId: string;
}

export interface DeductStockForInvoiceResult {
  invoiceId: string;
  /** Empty when the invoice carried no items with a recipe, when every
   * item was voided, or when the branch has no sale-deduction default
   * location configured — none of which is an error (see this service's
   * own docs). Also empty, without redoing any work, on a repeat call for
   * an invoice already deducted. */
  deducted: StockMovementRecord[];
}

const INVOICE_NOT_FOUND = "Invoice not found";

/**
 * P3-17: the first real consumer of stock_ledger's "sale" movement type
 * (P3-09 built the enum value with no caller until now) — fired from
 * InvoicesService.generate's own outbox row ("invoice.stock_deduct",
 * emitted alongside P2-26's "invoice.generated" in the same transaction)
 * and handled by apps/worker the same way ReconciliationService's handler
 * is (SalesStockDeductionHandlerProvider).
 *
 * Idempotent the way rule 9 asks: before writing anything, this checks
 * whether stock_ledger already has a "sale" row for this invoiceId and
 * returns early if so, rather than relying solely on "the outbox retries
 * a thrown handler" — a handler that succeeded but whose outbox row never
 * got marked processed (a crash between the two) would otherwise be
 * replayed and double-deduct.
 *
 * Combines a sold item's base recipe (by productId or variantId, whichever
 * the order item carries) with every one of its selected modifiers' own
 * recipe (P3-14 — e.g. "Extra Cheese" adding mozzarella on top) before
 * expanding to base units, per recipes.service.ts's own docs. Deliberately
 * does NOT recursively expand a semi-finished ingredient (e.g. "Marinara
 * Sauce") into ITS OWN recipe's raw ingredients — unlike a plain recipe
 * line, a semi-finished item already has real, trackable stock of its own
 * from P3-16's production batches, so deducting it directly (exactly like
 * any raw ingredient) is the correct move; expanding it again here would
 * double-count the raw ingredients a production batch already consumed.
 * A deeper cycle in the recipe graph is out of scope for the same reason
 * RecipesService only guards a direct self-reference — nothing here walks
 * a semi-finished item's own recipe at all.
 *
 * A voided item (P2-23) contributes nothing — deciding whether a void
 * returns stock or records it as wastage is P3-18's own job, not this
 * one's. A sold item or modifier with no recipe configured at all
 * contributes nothing either: inventory tracking is opt-in per product,
 * same as it's always been (RecipesService.get returning null is a
 * normal, expected state, not an error).
 *
 * P3-19: also writes one order_item_food_costs row per item, pricing its
 * own ingredient requirements at whatever each one's weighted-average
 * cost already is (read-only, taken before any of this call's own
 * stock_ledger writes, though it wouldn't matter either way since a
 * decrease never moves the average). See that table's own docs for why
 * only the item's *base* recipe id/version is stamped, not its
 * modifiers'.
 *
 * P3-42: expansion, costing and the actual writes are all set-based —
 * one fetch of every recipe/conversion/stock-level this invoice could
 * need, one bulk insert of every order_item_food_costs row, one bulk
 * insert of every stock_ledger row — regardless of how many items or
 * distinct ingredients the invoice carries. See
 * expandInvoiceIngredientsBatch/computeInvoiceLineCostsBatch/
 * StockLedgerService.recordSaleDeductionsInTx for why each one is safe to
 * batch this way. The idempotency guard below is unchanged by any of
 * this — still the first thing checked, still what actually prevents a
 * double deduction.
 */
@Injectable()
export class SalesStockDeductionService {
  private readonly logger = new Logger(SalesStockDeductionService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly stockLedgerService: StockLedgerService,
  ) {}

  async deductForInvoice(params: DeductStockForInvoiceParams): Promise<DeductStockForInvoiceResult> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const alreadyDeducted = await tx
        .select({ id: schema.stockLedger.id })
        .from(schema.stockLedger)
        .where(and(eq(schema.stockLedger.invoiceId, params.invoiceId), eq(schema.stockLedger.movementType, "sale")))
        .limit(1);
      if (alreadyDeducted.length > 0) return { invoiceId: params.invoiceId, deducted: [] };

      const invoiceRows = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, params.invoiceId));
      const invoice = invoiceRows[0];
      if (!invoice) throw new NotFoundException(INVOICE_NOT_FOUND);

      const defaultLocation = await findDefaultSaleDeductionLocation(tx, invoice.branchId);
      if (!defaultLocation) {
        this.logger.warn(`invoice ${params.invoiceId}: branch ${invoice.branchId} has no sale-deduction default storage location configured — skipping stock deduction`);
        return { invoiceId: params.invoiceId, deducted: [] };
      }

      const items = await tx.select().from(schema.orderItems).where(and(eq(schema.orderItems.invoiceId, params.invoiceId), isNull(schema.orderItems.voidedAt)));
      if (items.length === 0) return { invoiceId: params.invoiceId, deducted: [] };

      const modifiers = await tx.select().from(schema.orderItemModifiers).where(inArray(schema.orderItemModifiers.orderItemId, items.map((item) => item.id)));
      const modifiersByItem = new Map<string, (typeof modifiers)[number][]>();
      for (const modifier of modifiers) {
        const list = modifiersByItem.get(modifier.orderItemId) ?? [];
        list.push(modifier);
        modifiersByItem.set(modifier.orderItemId, list);
      }

      const { perItem, totalRequired } = await expandInvoiceIngredientsBatch(
        tx,
        params.restaurantId,
        items.map((item) => ({
          orderItemId: item.id,
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
          modifiers: (modifiersByItem.get(item.id) ?? []).map((modifier) => ({ modifierOptionId: modifier.modifierOptionId, quantity: modifier.quantity })),
        })),
      );

      // Priced before any of this call's own writes (see this service's own
      // docs — a decrease never changes the average, so order doesn't
      // actually matter, but reading first keeps that guarantee obvious).
      const costByOrderItemId = await computeInvoiceLineCostsBatch(tx, defaultLocation.id, perItem);
      if (perItem.length > 0) {
        await tx.insert(schema.orderItemFoodCosts).values(
          perItem.map((line) => {
            const cost = costByOrderItemId.get(line.orderItemId) ?? null;
            return {
              restaurantId: params.restaurantId,
              branchId: invoice.branchId,
              orderItemId: line.orderItemId,
              invoiceId: params.invoiceId,
              recipeId: line.baseRecipeId,
              recipeVersion: line.baseRecipeVersion,
              costMinor: cost?.amountMinor ?? null,
              currency: cost?.currency ?? null,
            };
          }),
        );
      }

      const deductions = new Map([...totalRequired].filter(([, quantity]) => quantity !== 0));
      const deducted = await this.stockLedgerService.recordSaleDeductionsInTx(tx, {
        restaurantId: params.restaurantId,
        actorUserId: invoice.actorUserId,
        storageLocationId: defaultLocation.id,
        invoiceId: params.invoiceId,
        deductions,
      });

      return { invoiceId: params.invoiceId, deducted };
    });
  }
}
