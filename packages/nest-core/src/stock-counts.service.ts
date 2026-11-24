import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { decodeCursor, seekCondition, toPage, type CursorFields, type Page } from "./cursor-pagination.js";
import { DATABASE } from "./db.module.js";
import { ManagerPinService } from "./manager-pin.service.js";
import { StockLedgerService, type StockMovementRecord } from "./stock-ledger.service.js";

export type StockCountType = "full" | "cycle";
export type StockCountStatus = "in_progress" | "submitted" | "approved";

export interface StockCountItemRecord {
  id: string;
  itemId: string;
  /** Null while the count is still in_progress — see this service's own
   * docs for why a blind count never exposes this during entry. */
  expectedQuantity: number | null;
  countedQuantity: number | null;
  countedAt: Date | null;
  countedByUserId: string | null;
}

export interface StockCountRecord {
  id: string;
  branchId: string;
  storageLocationId: string;
  countType: StockCountType;
  status: StockCountStatus;
  startedByUserId: string;
  submittedAt: Date | null;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  note: string | null;
  items: StockCountItemRecord[];
  createdAt: Date;
  updatedAt: Date;
}

export interface StartStockCountParams {
  restaurantId: string;
  actorUserId: string;
  branchId: string;
  storageLocationId: string;
  countType: StockCountType;
  /** Required for a "cycle" count (the caller-chosen subset); ignored —
   * every item stock_levels already tracks at this location is used
   * instead — for a "full" count. */
  itemIds?: string[];
  note?: string;
}

export interface SubmitLineCountParams {
  restaurantId: string;
  actorUserId: string;
  stockCountId: string;
  itemId: string;
  countedQuantity: number;
}

export interface FinalizeStockCountParams {
  restaurantId: string;
  actorUserId: string;
  stockCountId: string;
}

export interface ApproveStockCountParams {
  restaurantId: string;
  actorUserId: string;
  stockCountId: string;
  managerUserId: string;
  managerPin: string;
}

export interface ApproveStockCountResult {
  stockCount: StockCountRecord;
  adjustments: StockMovementRecord[];
}

export interface ListStockCountsParams {
  restaurantId: string;
  branchId?: string;
  storageLocationId?: string;
  status?: StockCountStatus;
  cursor?: string;
  limit?: number;
}

const DEFAULT_LIST_LIMIT = 20;
const LOCATION_NOT_FOUND = "Storage location not found";
const LOCATION_WRONG_BRANCH = "this storage location doesn't belong to the given branch";
const ITEM_IDS_REQUIRED_FOR_CYCLE = "itemIds is required for a cycle count";
const DUPLICATE_ITEM_ID = "each itemId can only appear once in a cycle count";
const ITEM_NOT_FOUND = "one or more item ids don't exist";
const NO_ITEMS_TO_COUNT = "this location has no tracked stock to count — nothing to start";
const COUNT_NOT_FOUND = "Stock count not found";
const ALREADY_SUBMITTED = "this stock count has already been submitted";
const NOT_SUBMITTED_FOR_APPROVAL = "only a submitted stock count can be approved";
const LINE_NOT_FOUND = "this item isn't part of this stock count";
const QUANTITY_MUST_NOT_BE_NEGATIVE = "countedQuantity must not be negative";
const LINES_STILL_UNCOUNTED = "every item must have a counted quantity before this count can be submitted";

/**
 * P3-26/P3-27: full and cycle stock counts with blind entry, variance
 * review and approval. "Blind" means the counter never sees
 * `expectedQuantity` while entering their own number — `get`/
 * `submitLineCount` both withhold it until `status` leaves in_progress,
 * at which point it becomes visible for review.
 *
 * "Offline support" is satisfied by the shape of `submitLineCount` itself
 * rather than a separate idempotency mechanism: it's a flat "set this
 * line's counted quantity" write, not an increment — calling it twice
 * with the same value (e.g. a retry after a dropped connection mid-count)
 * produces the exact same end state, so a counter walking around a store
 * room with spotty connectivity can safely retry any single line without
 * risking a double-counted quantity the way an incrementing write would.
 *
 * `approve` (P3-27) is the one moment stock actually moves — same
 * ManagerPinService pattern as a refund, and for the same reason: no
 * own-authority tier at all, since a count has already been fully
 * entered by the time anyone reviews it, leaving no "small enough to
 * skip approval" case the way a discount has. One "count" stock_ledger
 * movement per line whose countedQuantity differs from its
 * expectedQuantity (P3-09 built the enum value with no caller until now)
 * — a line that matches exactly produces nothing, since there's nothing
 * to correct.
 */
@Injectable()
export class StockCountsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
    private readonly managerPinService: ManagerPinService,
    private readonly stockLedgerService: StockLedgerService,
  ) {}

  async start(params: StartStockCountParams): Promise<StockCountRecord> {
    if (params.countType === "cycle") {
      if (!params.itemIds || params.itemIds.length === 0) throw new BadRequestException(ITEM_IDS_REQUIRED_FOR_CYCLE);
      if (new Set(params.itemIds).size !== params.itemIds.length) throw new BadRequestException(DUPLICATE_ITEM_ID);
    }

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const locationRows = await tx.select({ branchId: schema.storageLocations.branchId }).from(schema.storageLocations).where(eq(schema.storageLocations.id, params.storageLocationId));
      const location = locationRows[0];
      if (!location) throw new NotFoundException(LOCATION_NOT_FOUND);
      if (location.branchId !== params.branchId) throw new BadRequestException(LOCATION_WRONG_BRANCH);

      const levelRows = await tx
        .select({ itemId: schema.stockLevels.itemId, quantity: schema.stockLevels.quantity })
        .from(schema.stockLevels)
        .where(eq(schema.stockLevels.storageLocationId, params.storageLocationId));
      const expectedByItem = new Map(levelRows.map((row) => [row.itemId, row.quantity]));

      let itemIds: string[];
      if (params.countType === "full") {
        itemIds = levelRows.map((row) => row.itemId);
      } else {
        itemIds = params.itemIds!;
        const existingRows = await tx.select({ id: schema.inventoryItems.id }).from(schema.inventoryItems).where(inArray(schema.inventoryItems.id, itemIds));
        if (existingRows.length !== itemIds.length) throw new BadRequestException(ITEM_NOT_FOUND);
      }
      if (itemIds.length === 0) throw new BadRequestException(NO_ITEMS_TO_COUNT);

      const countRows = await tx
        .insert(schema.stockCounts)
        .values({
          restaurantId: params.restaurantId,
          branchId: params.branchId,
          storageLocationId: params.storageLocationId,
          countType: params.countType,
          startedByUserId: params.actorUserId,
          note: params.note ?? null,
        })
        .returning();
      const count = countRows[0];
      if (!count) throw new Error("start: stock count insert returned no row");

      const itemRows = await tx
        .insert(schema.stockCountItems)
        .values(itemIds.map((itemId) => ({ restaurantId: params.restaurantId, stockCountId: count.id, itemId, expectedQuantity: expectedByItem.get(itemId) ?? 0 })))
        .returning();

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, branchId: params.branchId, actorUserId: params.actorUserId, action: "stock_count.started", targetType: "stock_count", targetId: count.id, metadata: { countType: params.countType, itemCount: itemRows.length } },
        tx,
      );

      return this.toRecord(count, itemRows);
    });
  }

  async submitLineCount(params: SubmitLineCountParams): Promise<StockCountItemRecord> {
    if (params.countedQuantity < 0) throw new BadRequestException(QUANTITY_MUST_NOT_BE_NEGATIVE);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const count = await this.requireCount(tx, params.stockCountId);
      if (count.status !== "in_progress") throw new BadRequestException(ALREADY_SUBMITTED);

      const lineRows = await tx
        .update(schema.stockCountItems)
        .set({ countedQuantity: params.countedQuantity, countedAt: new Date(), countedByUserId: params.actorUserId })
        .where(and(eq(schema.stockCountItems.stockCountId, count.id), eq(schema.stockCountItems.itemId, params.itemId)))
        .returning();
      const line = lineRows[0];
      if (!line) throw new NotFoundException(LINE_NOT_FOUND);

      return { id: line.id, itemId: line.itemId, expectedQuantity: null, countedQuantity: line.countedQuantity, countedAt: line.countedAt, countedByUserId: line.countedByUserId };
    });
  }

  async finalize(params: FinalizeStockCountParams): Promise<StockCountRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const count = await this.requireCount(tx, params.stockCountId);
      if (count.status !== "in_progress") throw new BadRequestException(ALREADY_SUBMITTED);

      const items = await tx.select().from(schema.stockCountItems).where(eq(schema.stockCountItems.stockCountId, count.id));
      if (items.some((item) => item.countedQuantity === null)) throw new BadRequestException(LINES_STILL_UNCOUNTED);

      const rows = await tx
        .update(schema.stockCounts)
        .set({ status: "submitted", submittedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.stockCounts.id, count.id))
        .returning();
      const updated = rows[0]!;

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, branchId: count.branchId, actorUserId: params.actorUserId, action: "stock_count.submitted", targetType: "stock_count", targetId: count.id, metadata: { itemCount: items.length } },
        tx,
      );

      return this.toRecord(updated, items);
    });
  }

  async approve(params: ApproveStockCountParams): Promise<ApproveStockCountResult> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const count = await this.requireCount(tx, params.stockCountId);
      if (count.status !== "submitted") throw new BadRequestException(NOT_SUBMITTED_FOR_APPROVAL);

      await this.managerPinService.approve({
        restaurantId: params.restaurantId,
        branchId: count.branchId,
        managerUserId: params.managerUserId,
        pin: params.managerPin,
        requiredPermission: "inventory.count.approve",
        action: "stock_count.approve",
      });

      const items = await tx.select().from(schema.stockCountItems).where(eq(schema.stockCountItems.stockCountId, count.id));

      const adjustments: StockMovementRecord[] = [];
      for (const item of items) {
        const delta = item.countedQuantity! - item.expectedQuantity;
        if (delta === 0) continue;

        const movement = await this.stockLedgerService.recordMovementInTx(tx, {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          storageLocationId: count.storageLocationId,
          itemId: item.itemId,
          movementType: "count",
          quantityDelta: delta,
          note: `stock count ${count.id}`,
        });
        adjustments.push(movement);
      }

      const rows = await tx
        .update(schema.stockCounts)
        .set({ status: "approved", approvedByUserId: params.managerUserId, approvedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.stockCounts.id, count.id))
        .returning();
      const updated = rows[0]!;

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          branchId: count.branchId,
          actorUserId: params.actorUserId,
          action: "stock_count.approved",
          targetType: "stock_count",
          targetId: count.id,
          metadata: { approvedByUserId: params.managerUserId, adjustmentCount: adjustments.length },
        },
        tx,
      );

      return { stockCount: this.toRecord(updated, items), adjustments };
    });
  }

  async get(params: { restaurantId: string; stockCountId: string }): Promise<StockCountRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const count = await this.requireCount(tx, params.stockCountId);
      const items = await tx.select().from(schema.stockCountItems).where(eq(schema.stockCountItems.stockCountId, count.id));
      return this.toRecord(count, items);
    });
  }

  async list(params: ListStockCountsParams): Promise<Page<Omit<StockCountRecord, "items">>> {
    const limit = params.limit ?? DEFAULT_LIST_LIMIT;
    const after: CursorFields | undefined = params.cursor !== undefined ? decodeCursor(params.cursor) : undefined;
    const rows = await withTenant(this.db, { restaurantId: params.restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.stockCounts)
        .where(
          and(
            params.branchId !== undefined ? eq(schema.stockCounts.branchId, params.branchId) : undefined,
            params.storageLocationId !== undefined ? eq(schema.stockCounts.storageLocationId, params.storageLocationId) : undefined,
            params.status !== undefined ? eq(schema.stockCounts.status, params.status) : undefined,
            seekCondition(schema.stockCounts.createdAt, schema.stockCounts.id, after),
          ),
        )
        .orderBy(desc(schema.stockCounts.createdAt), desc(schema.stockCounts.id))
        .limit(limit + 1),
    );
    return toPage(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  }

  private async requireCount(tx: Database, stockCountId: string): Promise<typeof schema.stockCounts.$inferSelect> {
    const rows = await tx.select().from(schema.stockCounts).where(eq(schema.stockCounts.id, stockCountId));
    const count = rows[0];
    if (!count) throw new NotFoundException(COUNT_NOT_FOUND);
    return count;
  }

  private toRecord(count: typeof schema.stockCounts.$inferSelect, items: Array<typeof schema.stockCountItems.$inferSelect>): StockCountRecord {
    const blind = count.status === "in_progress";
    return {
      ...count,
      items: items.map((item) => ({
        id: item.id,
        itemId: item.itemId,
        expectedQuantity: blind ? null : item.expectedQuantity,
        countedQuantity: item.countedQuantity,
        countedAt: item.countedAt,
        countedByUserId: item.countedByUserId,
      })),
    };
  }
}
