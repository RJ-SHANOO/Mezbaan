import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { decodeCursor, seekCondition, toPage, type CursorFields, type Page } from "./cursor-pagination.js";
import { DATABASE } from "./db.module.js";

export interface SupplierItemPriceRecord {
  id: string;
  supplierId: string;
  itemId: string;
  unitPriceMinor: bigint;
  currency: string;
  unitId: string;
  note: string | null;
  actorUserId: string;
  createdAt: Date;
}

export interface RecordSupplierItemPriceParams {
  restaurantId: string;
  actorUserId: string;
  supplierId: string;
  itemId: string;
  unitPriceMinor: bigint;
  currency: string;
  unitId: string;
  note?: string;
}

export interface ListSupplierItemPricesParams {
  restaurantId: string;
  supplierId: string;
  itemId: string;
  cursor?: string;
  limit?: number;
}

const DEFAULT_LIST_LIMIT = 20;
const LINK_NOT_FOUND = "this supplier isn't linked to this item — link it first (POST /supplier-items) before recording a price";
const UNIT_NOT_FOUND = "Unit not found";
const PRICE_MUST_BE_POSITIVE = "unitPriceMinor must be greater than zero";

/**
 * P3-20: append-only price history (rule 4's convention, UPDATE/DELETE
 * revoked in app-role.ts) — see supplier-item-prices.ts's own docs for why
 * a new price is always a new row. `record` requires the (supplier, item)
 * pair to already be linked via SupplierItemsService — a price for an
 * item this supplier doesn't even supply would be meaningless.
 */
@Injectable()
export class SupplierItemPricesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async record(params: RecordSupplierItemPriceParams): Promise<SupplierItemPriceRecord> {
    if (params.unitPriceMinor <= 0n) throw new BadRequestException(PRICE_MUST_BE_POSITIVE);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const linkRows = await tx
        .select({ id: schema.supplierItems.id })
        .from(schema.supplierItems)
        .where(and(eq(schema.supplierItems.supplierId, params.supplierId), eq(schema.supplierItems.itemId, params.itemId)));
      if (linkRows.length === 0) throw new NotFoundException(LINK_NOT_FOUND);

      const unitRows = await tx.select({ id: schema.units.id }).from(schema.units).where(eq(schema.units.id, params.unitId));
      if (unitRows.length === 0) throw new NotFoundException(UNIT_NOT_FOUND);

      const rows = await tx
        .insert(schema.supplierItemPrices)
        .values({
          restaurantId: params.restaurantId,
          supplierId: params.supplierId,
          itemId: params.itemId,
          unitPriceMinor: params.unitPriceMinor,
          currency: params.currency,
          unitId: params.unitId,
          note: params.note ?? null,
          actorUserId: params.actorUserId,
        })
        .returning();
      const price = rows[0];
      if (!price) throw new Error("record: supplier item price insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "supplier_item_price.recorded",
          targetType: "supplier_item_price",
          targetId: price.id,
          metadata: { supplierId: params.supplierId, itemId: params.itemId, unitPriceMinor: price.unitPriceMinor.toString(), currency: price.currency },
        },
        tx,
      );
      return price;
    });
  }

  /** The most recent row for this (supplier, item) pair — null if a price has never been recorded. */
  async getCurrent(params: { restaurantId: string; supplierId: string; itemId: string }): Promise<SupplierItemPriceRecord | null> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.supplierItemPrices)
        .where(and(eq(schema.supplierItemPrices.supplierId, params.supplierId), eq(schema.supplierItemPrices.itemId, params.itemId)))
        .orderBy(desc(schema.supplierItemPrices.createdAt), desc(schema.supplierItemPrices.id))
        .limit(1);
      return rows[0] ?? null;
    });
  }

  async list(params: ListSupplierItemPricesParams): Promise<Page<SupplierItemPriceRecord>> {
    const limit = params.limit ?? DEFAULT_LIST_LIMIT;
    const after: CursorFields | undefined = params.cursor !== undefined ? decodeCursor(params.cursor) : undefined;
    const rows = await withTenant(this.db, { restaurantId: params.restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.supplierItemPrices)
        .where(
          and(
            eq(schema.supplierItemPrices.supplierId, params.supplierId),
            eq(schema.supplierItemPrices.itemId, params.itemId),
            seekCondition(schema.supplierItemPrices.createdAt, schema.supplierItemPrices.id, after),
          ),
        )
        .orderBy(desc(schema.supplierItemPrices.createdAt), desc(schema.supplierItemPrices.id))
        .limit(limit + 1),
    );
    return toPage(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
  }
}
