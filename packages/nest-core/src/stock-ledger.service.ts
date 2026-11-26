import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { decodeCursor, seekCondition, toPage, type CursorFields, type Page } from "./cursor-pagination.js";
import { DATABASE } from "./db.module.js";
import { NegativeStockFlagsService } from "./negative-stock-flags.service.js";
import { StockLevelsService } from "./stock-levels.service.js";

export type MovementType = "purchase" | "sale" | "return" | "wastage" | "adjustment" | "count" | "production" | "transfer";

export interface StockMovementRecord {
  id: string;
  branchId: string;
  storageLocationId: string;
  itemId: string;
  movementType: MovementType;
  quantityDelta: number;
  transferGroupId: string | null;
  productionBatchId: string | null;
  invoiceId: string | null;
  unitCostMinor: bigint | null;
  currency: string | null;
  note: string | null;
  actorUserId: string;
  createdAt: Date;
}

export interface RecordMovementParams {
  restaurantId: string;
  actorUserId: string;
  storageLocationId: string;
  itemId: string;
  movementType: Exclude<MovementType, "transfer">;
  quantityDelta: number;
  /** Only meaningful for an increase (quantityDelta > 0) — what this
   * delivery/batch cost, folded into the item's weighted average at this
   * location. Ignored for a decrease, which is always valued at the
   * current average instead (see StockLevelsService.applyDelta). */
  unitCostMinor?: bigint;
  currency?: string;
  /** P3-16: links this row to the other stock_ledger rows one production
   * batch produces (its consumed ingredients, plus the finished item's own
   * entry) — see stock-ledger.ts's own docs. Null for every other caller. */
  productionBatchId?: string;
  /** P3-17: links this row to the other stock_ledger rows one invoice's
   * sale deduction produces (one per distinct ingredient) — see
   * stock-ledger.ts's own docs. Null for every other caller. */
  invoiceId?: string;
  note?: string;
}

export interface RecordSaleDeductionsParams {
  restaurantId: string;
  actorUserId: string;
  storageLocationId: string;
  invoiceId: string;
  /** itemId -> total quantity to deduct, always a positive magnitude —
   * this method negates it onto the ledger/stock_levels itself, same sign
   * convention `recordMovementInTx` callers already follow for a "sale". */
  deductions: Map<string, number>;
}

export interface RecordTransferParams {
  restaurantId: string;
  actorUserId: string;
  itemId: string;
  fromStorageLocationId: string;
  toStorageLocationId: string;
  quantity: number;
  note?: string;
}

export interface ListMovementsParams {
  restaurantId: string;
  branchId?: string;
  storageLocationId?: string;
  itemId?: string;
  movementType?: MovementType;
  productionBatchId?: string;
  invoiceId?: string;
  cursor?: string;
  limit?: number;
}

export interface GetAuditTrailParams {
  restaurantId: string;
  storageLocationId: string;
  itemId: string;
}

export interface AuditTrailEntryRecord extends StockMovementRecord {
  /** The resulting on-hand quantity at this location right after this
   * movement — see `getAuditTrail`'s own docs for why this is computed
   * by replay rather than stored on stock_ledger itself. */
  balanceAfter: number;
}

const DEFAULT_LIST_LIMIT = 20;
const ITEM_NOT_FOUND = "Inventory item not found";
const LOCATION_NOT_FOUND = "Storage location not found";
const QUANTITY_ZERO = "quantityDelta must not be zero";
const SAME_LOCATION_TRANSFER = "fromStorageLocationId and toStorageLocationId must be different";
const CROSS_BRANCH_TRANSFER = "a transfer between different branches isn't supported yet — that's a planned, separate branch-transfer workflow (request/dispatch/receive), not a same-branch location move";

/**
 * P3-09: the append-only stock ledger (rule 4 — UPDATE/DELETE revoked at
 * the DB level in app-role.ts, same enforcement as invoices/payments/
 * refunds/credit_ledger_entries). This is the *only* real source of truth
 * for stock; every insert here also upserts P3-10's stock_levels cache
 * (StockLevelsService.applyDelta) in the same transaction, so a reader
 * never re-sums the whole ledger to know a current level — see that
 * service's own docs for why a cache exists here when CreditCustomers'
 * balance deliberately doesn't. A wrong entry is corrected with a new,
 * opposite-signed row, never an edit.
 *
 * `quantityDelta` must already be in the item's own base unit
 * (inventory_items.baseUnitId) — a caller working in a different unit
 * (e.g. receiving a purchase in cartons) converts first via
 * InventoryItemUnitConversionsService/packages/domain's convertQuantity,
 * same "this table never converts on its own" reasoning as the schema's
 * own docs.
 *
 * A "transfer" is the one movement type that always produces two rows —
 * see recordTransfer — restricted to two locations in the *same* branch
 * for now; a cross-branch transfer is P4-12's own, more elaborate
 * request/dispatch/receive workflow, not this primitive.
 */
@Injectable()
export class StockLedgerService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
    private readonly stockLevelsService: StockLevelsService,
    private readonly negativeStockFlagsService: NegativeStockFlagsService,
  ) {}

  async recordMovement(params: RecordMovementParams): Promise<StockMovementRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, (tx) => this.recordMovementInTx(tx, params));
  }

  /**
   * Same as `recordMovement`, but runs inside a `tx` the caller already
   * has open — for a multi-step write that must all-or-nothing commit
   * together across more than one call (P3-16's production batches:
   * several ingredient deductions plus one finished-stock increase, all
   * one atomic unit). `recordMovement` itself is just this wrapped in its
   * own transaction, for every ordinary single-movement caller.
   */
  async recordMovementInTx(tx: Database, params: RecordMovementParams): Promise<StockMovementRecord> {
    if (params.quantityDelta === 0) throw new BadRequestException(QUANTITY_ZERO);

    await this.requireItem(tx, params.itemId);
    const location = await this.requireLocation(tx, params.storageLocationId);

    const snapshot = await this.stockLevelsService.applyDelta(tx, {
      restaurantId: params.restaurantId,
      branchId: location.branchId,
      storageLocationId: params.storageLocationId,
      itemId: params.itemId,
      quantityDelta: params.quantityDelta,
      unitCostMinor: params.unitCostMinor,
      currency: params.currency,
    });

    const rows = await tx
      .insert(schema.stockLedger)
      .values({
        restaurantId: params.restaurantId,
        branchId: location.branchId,
        storageLocationId: params.storageLocationId,
        itemId: params.itemId,
        movementType: params.movementType,
        quantityDelta: params.quantityDelta,
        productionBatchId: params.productionBatchId ?? null,
        invoiceId: params.invoiceId ?? null,
        unitCostMinor: snapshot.unitCostMinor,
        currency: snapshot.currency,
        note: params.note ?? null,
        actorUserId: params.actorUserId,
      })
      .returning();
    const movement = rows[0];
    if (!movement) throw new Error("recordMovement: insert returned no row");

    await this.auditLogService.record(
      {
        restaurantId: params.restaurantId,
        branchId: movement.branchId,
        actorUserId: params.actorUserId,
        action: "stock_ledger.movement_recorded",
        targetType: "stock_ledger",
        targetId: movement.id,
        metadata: { itemId: movement.itemId, movementType: movement.movementType, quantityDelta: movement.quantityDelta, storageLocationId: movement.storageLocationId },
      },
      tx,
    );

    // Rule 12: never block the sale/movement itself — this only ever
    // flags it for later review, after it's already recorded.
    if (snapshot.newQuantity < 0) {
      await this.negativeStockFlagsService.create(tx, {
        restaurantId: params.restaurantId,
        branchId: movement.branchId,
        storageLocationId: movement.storageLocationId,
        itemId: movement.itemId,
        stockLedgerId: movement.id,
        quantityAfter: snapshot.newQuantity,
      });
    }

    return movement;
  }

  /**
   * P3-42: the set-based sibling of `recordMovementInTx`, for exactly the
   * one case that's safe to batch this way — a "sale" deduction, always a
   * decrease, which per `StockLevelsService.applyDelta`'s own rule never
   * touches the running average cost at all. That's what makes one
   * bulk `INSERT ... ON CONFLICT DO UPDATE` safe here: every row's new
   * quantity is simply "whatever it already was, plus this row's own
   * signed delta" (`excluded.quantity` in the ON CONFLICT branch; the
   * VALUES row's own `quantity` in the fresh-insert branch, since a brand
   * new row starts from zero) — no cost blending, so no row needs to see
   * another row's result first the way an increase would. SalesStockDeductionService's own invoiceId-based pre-check (not this
   * method) is what keeps the whole call idempotent — this method has no
   * idempotency guard of its own, same division of responsibility as
   * `recordMovementInTx`/`deductForInvoice` already have.
   */
  async recordSaleDeductionsInTx(tx: Database, params: RecordSaleDeductionsParams): Promise<StockMovementRecord[]> {
    if (params.deductions.size === 0) return [];

    const location = await this.requireLocation(tx, params.storageLocationId);

    const itemIds = [...params.deductions.keys()];
    const itemRows = await tx.select({ id: schema.inventoryItems.id }).from(schema.inventoryItems).where(inArray(schema.inventoryItems.id, itemIds));
    if (itemRows.length !== itemIds.length) throw new NotFoundException(ITEM_NOT_FOUND);

    const signedDeltaByItemId = new Map(itemIds.map((itemId) => [itemId, -(params.deductions.get(itemId) ?? 0)]));

    const updatedLevels = await tx
      .insert(schema.stockLevels)
      .values(
        itemIds.map((itemId) => ({
          restaurantId: params.restaurantId,
          branchId: location.branchId,
          storageLocationId: params.storageLocationId,
          itemId,
          quantity: signedDeltaByItemId.get(itemId) ?? 0,
        })),
      )
      .onConflictDoUpdate({
        target: [schema.stockLevels.storageLocationId, schema.stockLevels.itemId],
        set: { quantity: sql`${schema.stockLevels.quantity} + excluded.quantity`, updatedAt: new Date() },
      })
      .returning({ itemId: schema.stockLevels.itemId, quantity: schema.stockLevels.quantity, averageCostMinor: schema.stockLevels.averageCostMinor, currency: schema.stockLevels.currency });
    const levelByItemId = new Map(updatedLevels.map((row) => [row.itemId, row]));

    const movementRows = await tx
      .insert(schema.stockLedger)
      .values(
        itemIds.map((itemId) => {
          const level = levelByItemId.get(itemId);
          return {
            restaurantId: params.restaurantId,
            branchId: location.branchId,
            storageLocationId: params.storageLocationId,
            itemId,
            movementType: "sale" as const,
            quantityDelta: signedDeltaByItemId.get(itemId) ?? 0,
            invoiceId: params.invoiceId,
            unitCostMinor: level?.averageCostMinor ?? null,
            currency: level?.currency ?? null,
            actorUserId: params.actorUserId,
          };
        }),
      )
      .returning();

    await this.auditLogService.record(
      {
        restaurantId: params.restaurantId,
        branchId: location.branchId,
        actorUserId: params.actorUserId,
        action: "stock_ledger.sale_deduction_batch_recorded",
        targetType: "invoice",
        targetId: params.invoiceId,
        metadata: { itemCount: movementRows.length, itemIds },
      },
      tx,
    );

    // Rule 12: never block the sale itself — this only ever flags an item
    // for later review, after it's already recorded. Same check as
    // recordMovementInTx's, just against the batch's own returned rows
    // instead of a single snapshot.
    for (const movement of movementRows) {
      const level = levelByItemId.get(movement.itemId);
      if (level && level.quantity < 0) {
        await this.negativeStockFlagsService.create(tx, {
          restaurantId: params.restaurantId,
          branchId: location.branchId,
          storageLocationId: params.storageLocationId,
          itemId: movement.itemId,
          stockLedgerId: movement.id,
          quantityAfter: level.quantity,
        });
      }
    }

    return movementRows;
  }

  /** Always two rows, sharing a new transferGroupId: a negative entry at
   * `fromStorageLocationId`, a positive one at `toStorageLocationId`. */
  async recordTransfer(params: RecordTransferParams): Promise<{ outbound: StockMovementRecord; inbound: StockMovementRecord }> {
    if (params.fromStorageLocationId === params.toStorageLocationId) throw new BadRequestException(SAME_LOCATION_TRANSFER);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      await this.requireItem(tx, params.itemId);
      const fromLocation = await this.requireLocation(tx, params.fromStorageLocationId);
      const toLocation = await this.requireLocation(tx, params.toStorageLocationId);
      if (fromLocation.branchId !== toLocation.branchId) throw new BadRequestException(CROSS_BRANCH_TRANSFER);

      const transferGroupId = randomUUID();

      // Outbound first: a transfer moves stock at whatever it's already
      // worth at the source, never a cost the caller invents — so no
      // unitCostMinor/currency is supplied here, same as any other
      // decrease. The returned snapshot (the source's current average)
      // is then what the destination receives it at.
      const outboundSnapshot = await this.stockLevelsService.applyDelta(tx, {
        restaurantId: params.restaurantId,
        branchId: fromLocation.branchId,
        storageLocationId: params.fromStorageLocationId,
        itemId: params.itemId,
        quantityDelta: -params.quantity,
      });
      const inboundSnapshot = await this.stockLevelsService.applyDelta(tx, {
        restaurantId: params.restaurantId,
        branchId: toLocation.branchId,
        storageLocationId: params.toStorageLocationId,
        itemId: params.itemId,
        quantityDelta: params.quantity,
        unitCostMinor: outboundSnapshot.unitCostMinor ?? undefined,
        currency: outboundSnapshot.currency ?? undefined,
      });

      const outboundRows = await tx
        .insert(schema.stockLedger)
        .values({
          restaurantId: params.restaurantId,
          branchId: fromLocation.branchId,
          storageLocationId: params.fromStorageLocationId,
          itemId: params.itemId,
          movementType: "transfer",
          quantityDelta: -params.quantity,
          transferGroupId,
          unitCostMinor: outboundSnapshot.unitCostMinor,
          currency: outboundSnapshot.currency,
          note: params.note ?? null,
          actorUserId: params.actorUserId,
        })
        .returning();
      const inboundRows = await tx
        .insert(schema.stockLedger)
        .values({
          restaurantId: params.restaurantId,
          branchId: toLocation.branchId,
          storageLocationId: params.toStorageLocationId,
          itemId: params.itemId,
          movementType: "transfer",
          quantityDelta: params.quantity,
          transferGroupId,
          unitCostMinor: inboundSnapshot.unitCostMinor,
          currency: inboundSnapshot.currency,
          note: params.note ?? null,
          actorUserId: params.actorUserId,
        })
        .returning();
      const outbound = outboundRows[0];
      const inbound = inboundRows[0];
      if (!outbound || !inbound) throw new Error("recordTransfer: insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "stock_ledger.transfer_recorded",
          targetType: "stock_ledger",
          targetId: transferGroupId,
          metadata: { itemId: params.itemId, fromStorageLocationId: params.fromStorageLocationId, toStorageLocationId: params.toStorageLocationId, quantity: params.quantity },
        },
        tx,
      );

      // Only the outbound leg can ever go negative — the inbound leg is
      // always an increase. Same "flag, never block" rule as recordMovement.
      if (outboundSnapshot.newQuantity < 0) {
        await this.negativeStockFlagsService.create(tx, {
          restaurantId: params.restaurantId,
          branchId: outbound.branchId,
          storageLocationId: outbound.storageLocationId,
          itemId: outbound.itemId,
          stockLedgerId: outbound.id,
          quantityAfter: outboundSnapshot.newQuantity,
        });
      }

      return { outbound, inbound };
    });
  }

  async list(params: ListMovementsParams): Promise<Page<StockMovementRecord>> {
    const limit = params.limit ?? DEFAULT_LIST_LIMIT;
    const after: CursorFields | undefined = params.cursor !== undefined ? decodeCursor(params.cursor) : undefined;
    const rows = await withTenant(this.db, { restaurantId: params.restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.stockLedger)
        .where(
          and(
            params.branchId !== undefined ? eq(schema.stockLedger.branchId, params.branchId) : undefined,
            params.storageLocationId !== undefined ? eq(schema.stockLedger.storageLocationId, params.storageLocationId) : undefined,
            params.itemId !== undefined ? eq(schema.stockLedger.itemId, params.itemId) : undefined,
            params.movementType !== undefined ? eq(schema.stockLedger.movementType, params.movementType) : undefined,
            params.productionBatchId !== undefined ? eq(schema.stockLedger.productionBatchId, params.productionBatchId) : undefined,
            params.invoiceId !== undefined ? eq(schema.stockLedger.invoiceId, params.invoiceId) : undefined,
            seekCondition(schema.stockLedger.createdAt, schema.stockLedger.id, after),
          ),
        )
        .orderBy(desc(schema.stockLedger.createdAt), desc(schema.stockLedger.id))
        .limit(limit + 1),
    );
    return toPage(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  }

  /**
   * P3-30: the full history behind one (storage location, item) pair's
   * current stock number — every movement that ever touched it, oldest
   * first, each annotated with the resulting on-hand quantity right
   * after it. `balanceAfter` is computed by replaying every row in
   * order rather than stored on stock_ledger itself — same
   * derive-don't-duplicate reasoning as stock_levels.ts's own relationship
   * to the ledger (and the same replay `StockLevelsService.rebuild` already
   * does, just scoped to one pair instead of the whole table and exposed as
   * a queryable view rather than an internal integrity check). Deliberately
   * not paginated like `list()` — a single item's own lifetime history at
   * one location is bounded by how often that specific item moves, not by
   * the size of the restaurant's overall ledger, so a full in-order replay
   * here is the same scale of work `rebuild` already treats as acceptable.
   */
  async getAuditTrail(params: GetAuditTrailParams): Promise<AuditTrailEntryRecord[]> {
    const rows = await withTenant(this.db, { restaurantId: params.restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.stockLedger)
        .where(and(eq(schema.stockLedger.storageLocationId, params.storageLocationId), eq(schema.stockLedger.itemId, params.itemId)))
        .orderBy(schema.stockLedger.createdAt, schema.stockLedger.id),
    );

    let balance = 0;
    return rows.map((row) => {
      balance += row.quantityDelta;
      return { ...row, balanceAfter: balance };
    });
  }

  private async requireItem(tx: Database, itemId: string): Promise<void> {
    const rows = await tx.select({ id: schema.inventoryItems.id }).from(schema.inventoryItems).where(eq(schema.inventoryItems.id, itemId));
    if (rows.length === 0) throw new NotFoundException(ITEM_NOT_FOUND);
  }

  private async requireLocation(tx: Database, locationId: string): Promise<{ branchId: string }> {
    const rows = await tx.select({ branchId: schema.storageLocations.branchId }).from(schema.storageLocations).where(eq(schema.storageLocations.id, locationId));
    const location = rows[0];
    if (!location) throw new NotFoundException(LOCATION_NOT_FOUND);
    return location;
  }
}
