import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { decodeCursor, seekCondition, toPage, type CursorFields, type Page } from "./cursor-pagination.js";
import { DATABASE } from "./db.module.js";

export interface NegativeStockFlagRecord {
  id: string;
  branchId: string;
  storageLocationId: string;
  itemId: string;
  stockLedgerId: string;
  quantityAfter: number;
  reviewedAt: Date | null;
  reviewedByUserId: string | null;
  createdAt: Date;
}

export interface CreateFlagParams {
  restaurantId: string;
  branchId: string;
  storageLocationId: string;
  itemId: string;
  stockLedgerId: string;
  quantityAfter: number;
}

export interface ListFlagsParams {
  restaurantId: string;
  branchId?: string;
  /** true: only already-reviewed flags. false: only still-open ones — the
   * review screen's default working view. Omitted: every flag. */
  reviewed?: boolean;
  cursor?: string;
  limit?: number;
}

export interface ReviewFlagParams {
  restaurantId: string;
  actorUserId: string;
  flagId: string;
}

const DEFAULT_LIST_LIMIT = 20;
const FLAG_NOT_FOUND = "Negative stock flag not found";
const ALREADY_REVIEWED = "This flag has already been reviewed";

/**
 * P3-12 (rule 12: "Offline stock may go negative. Record and flag it, and
 * never block a sale because of it."). `create` is called by
 * StockLedgerService inside the same transaction as the movement that
 * caused it — see negative-stock-flags.ts's own docs for why this is
 * generic across every movement type, not sale-specific, despite this
 * task's name. `review` is the screen's actual action: once a manager
 * has looked at it, mark it reviewed — a flag is never deleted (it stays
 * visible in history filtered to reviewed=true), and never reviewed
 * twice.
 */
@Injectable()
export class NegativeStockFlagsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  /** Must be called with the same `tx` as the stock_ledger insert that caused this — never its own transaction. */
  async create(tx: Database, params: CreateFlagParams): Promise<NegativeStockFlagRecord> {
    const rows = await tx
      .insert(schema.negativeStockFlags)
      .values({
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        storageLocationId: params.storageLocationId,
        itemId: params.itemId,
        stockLedgerId: params.stockLedgerId,
        quantityAfter: params.quantityAfter,
      })
      .returning();
    const flag = rows[0];
    if (!flag) throw new Error("create: negative stock flag insert returned no row");
    return flag;
  }

  async list(params: ListFlagsParams): Promise<Page<NegativeStockFlagRecord>> {
    const limit = params.limit ?? DEFAULT_LIST_LIMIT;
    const after: CursorFields | undefined = params.cursor !== undefined ? decodeCursor(params.cursor) : undefined;
    const rows = await withTenant(this.db, { restaurantId: params.restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.negativeStockFlags)
        .where(
          and(
            params.branchId !== undefined ? eq(schema.negativeStockFlags.branchId, params.branchId) : undefined,
            params.reviewed === true
              ? isNotNull(schema.negativeStockFlags.reviewedAt)
              : params.reviewed === false
                ? isNull(schema.negativeStockFlags.reviewedAt)
                : undefined,
            seekCondition(schema.negativeStockFlags.createdAt, schema.negativeStockFlags.id, after),
          ),
        )
        .orderBy(desc(schema.negativeStockFlags.createdAt), desc(schema.negativeStockFlags.id))
        .limit(limit + 1),
    );
    return toPage(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  }

  async review(params: ReviewFlagParams): Promise<NegativeStockFlagRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const existingRows = await tx.select().from(schema.negativeStockFlags).where(eq(schema.negativeStockFlags.id, params.flagId));
      const existing = existingRows[0];
      if (!existing) throw new NotFoundException(FLAG_NOT_FOUND);
      if (existing.reviewedAt !== null) throw new BadRequestException(ALREADY_REVIEWED);

      const rows = await tx
        .update(schema.negativeStockFlags)
        .set({ reviewedAt: new Date(), reviewedByUserId: params.actorUserId })
        .where(eq(schema.negativeStockFlags.id, params.flagId))
        .returning();
      const flag = rows[0];
      if (!flag) throw new Error("review: update returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          branchId: flag.branchId,
          actorUserId: params.actorUserId,
          action: "negative_stock_flag.reviewed",
          targetType: "negative_stock_flag",
          targetId: flag.id,
          metadata: { itemId: flag.itemId, storageLocationId: flag.storageLocationId, quantityAfter: flag.quantityAfter },
        },
        tx,
      );
      return flag;
    });
  }
}
