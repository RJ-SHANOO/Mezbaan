import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE } from "./db.module.js";
import { RecipesService } from "./recipes.service.js";
import { StockLedgerService, type StockMovementRecord } from "./stock-ledger.service.js";
import { StockLevelsService } from "./stock-levels.service.js";
import { computeLineCost, expandLineIngredients, findDefaultSaleDeductionLocation } from "./stock-deduction-shared.js";

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
 * cost already is (computeLineCost — read-only, taken before any of this
 * call's own stock_ledger writes, though it wouldn't matter either way
 * since a decrease never moves the average). See that table's own docs
 * for why only the item's *base* recipe id/version is stamped, not its
 * modifiers'.
 */
@Injectable()
export class SalesStockDeductionService {
  private readonly logger = new Logger(SalesStockDeductionService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly recipesService: RecipesService,
    private readonly stockLedgerService: StockLedgerService,
    private readonly stockLevelsService: StockLevelsService,
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

      const requiredBaseQuantity = new Map<string, number>();
      const addRequirement = (itemId: string, quantity: number) => requiredBaseQuantity.set(itemId, (requiredBaseQuantity.get(itemId) ?? 0) + quantity);

      // Per-item, not just aggregated: P3-19 needs each item's own recipe
      // id/version and cost, which the combined requiredBaseQuantity map
      // below (used only for the actual ledger writes, one row per
      // distinct ingredient across the whole invoice) can't give back.
      const foodCostInputs: Array<{ item: (typeof items)[number]; required: Map<string, number>; baseRecipeId: string | null; baseRecipeVersion: number | null }> = [];
      for (const item of items) {
        const expanded = await expandLineIngredients(tx, this.recipesService, params.restaurantId, {
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
          modifiers: (modifiersByItem.get(item.id) ?? []).map((modifier) => ({ modifierOptionId: modifier.modifierOptionId, quantity: modifier.quantity })),
        });
        foodCostInputs.push({ item, required: expanded.required, baseRecipeId: expanded.baseRecipeId, baseRecipeVersion: expanded.baseRecipeVersion });
        for (const [itemId, quantity] of expanded.required) addRequirement(itemId, quantity);
      }

      // Priced before any of this call's own writes (see this service's own
      // docs — a decrease never changes the average, so order doesn't
      // actually matter, but reading first keeps that guarantee obvious).
      for (const { item, required, baseRecipeId, baseRecipeVersion } of foodCostInputs) {
        const cost = await computeLineCost(tx, this.stockLevelsService, params.restaurantId, defaultLocation.id, required);
        await tx.insert(schema.orderItemFoodCosts).values({
          restaurantId: params.restaurantId,
          branchId: invoice.branchId,
          orderItemId: item.id,
          invoiceId: params.invoiceId,
          recipeId: baseRecipeId,
          recipeVersion: baseRecipeVersion,
          costMinor: cost?.amountMinor ?? null,
          currency: cost?.currency ?? null,
        });
      }

      const deducted: StockMovementRecord[] = [];
      for (const [itemId, quantity] of requiredBaseQuantity) {
        if (quantity === 0) continue;
        const movement = await this.stockLedgerService.recordMovementInTx(tx, {
          restaurantId: params.restaurantId,
          actorUserId: invoice.actorUserId,
          storageLocationId: defaultLocation.id,
          itemId,
          movementType: "sale",
          quantityDelta: -quantity,
          invoiceId: params.invoiceId,
        });
        deducted.push(movement);
      }

      return { invoiceId: params.invoiceId, deducted };
    });
  }
}
