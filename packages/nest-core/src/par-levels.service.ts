import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface ItemParLevelRecord {
  id: string;
  storageLocationId: string;
  itemId: string;
  minQuantity: number;
  parQuantity: number;
  updatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SetParLevelParams {
  restaurantId: string;
  actorUserId: string;
  storageLocationId: string;
  itemId: string;
  minQuantity: number;
  parQuantity: number;
}

export interface ListParLevelsParams {
  restaurantId: string;
  storageLocationId?: string;
  itemId?: string;
}

export interface DeleteParLevelParams {
  restaurantId: string;
  actorUserId: string;
  parLevelId: string;
}

export interface LowStockItemRecord {
  storageLocationId: string;
  itemId: string;
  quantity: number;
  minQuantity: number;
  parQuantity: number;
}

export interface ListLowStockParams {
  restaurantId: string;
  branchId?: string;
  storageLocationId?: string;
}

const LOCATION_NOT_FOUND = "Storage location not found";
const ITEM_NOT_FOUND = "Inventory item not found";
const MIN_NON_NEGATIVE = "minQuantity must not be negative";
const PAR_BELOW_MIN = "parQuantity must be greater than or equal to minQuantity";
const LEVEL_NOT_FOUND = "Par level not found";

/**
 * P3-29: minimum/par stock levels per (storage location, item) and the
 * low-stock check they exist for. `listLowStock` is a live query, not a
 * stored event or flag — being "low" is an ongoing state of the current
 * stock_levels snapshot compared against a configured threshold, not
 * something that happens once and needs a historical record the way a
 * negative-stock movement does. A missing stock_levels row (nothing has
 * ever moved at that location) is treated as quantity zero, same
 * convention stock_counts.ts's own "expectedQuantity... 0 if the item has
 * no stock_levels row there yet" already uses — otherwise a genuinely
 * never-stocked item with a configured threshold would wrongly never
 * show up as low.
 *
 * Deliberately does not compute a reorder suggestion
 * (parQuantity - quantity) — that's P4-14's own, later task, which also
 * needs sales history this table has nothing to do with. This only
 * answers "is this item low right now."
 */
@Injectable()
export class ParLevelsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async setLevel(params: SetParLevelParams): Promise<ItemParLevelRecord> {
    if (params.minQuantity < 0) throw new BadRequestException(MIN_NON_NEGATIVE);
    if (params.parQuantity < params.minQuantity) throw new BadRequestException(PAR_BELOW_MIN);

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const locationRows = await tx.select({ id: schema.storageLocations.id }).from(schema.storageLocations).where(eq(schema.storageLocations.id, params.storageLocationId));
      if (locationRows.length === 0) throw new NotFoundException(LOCATION_NOT_FOUND);

      const itemRows = await tx.select({ id: schema.inventoryItems.id }).from(schema.inventoryItems).where(eq(schema.inventoryItems.id, params.itemId));
      if (itemRows.length === 0) throw new NotFoundException(ITEM_NOT_FOUND);

      const rows = await tx
        .insert(schema.itemParLevels)
        .values({
          restaurantId: params.restaurantId,
          storageLocationId: params.storageLocationId,
          itemId: params.itemId,
          minQuantity: params.minQuantity,
          parQuantity: params.parQuantity,
          updatedByUserId: params.actorUserId,
        })
        .onConflictDoUpdate({
          target: [schema.itemParLevels.storageLocationId, schema.itemParLevels.itemId],
          set: { minQuantity: params.minQuantity, parQuantity: params.parQuantity, updatedByUserId: params.actorUserId, updatedAt: new Date() },
        })
        .returning();
      const level = rows[0];
      if (!level) throw new Error("setLevel: upsert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "item_par_level.set",
          targetType: "item_par_level",
          targetId: level.id,
          metadata: { storageLocationId: params.storageLocationId, itemId: params.itemId, minQuantity: params.minQuantity, parQuantity: params.parQuantity },
        },
        tx,
      );
      return level;
    });
  }

  async listLevels(params: ListParLevelsParams): Promise<ItemParLevelRecord[]> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.itemParLevels)
        .where(
          and(
            params.storageLocationId !== undefined ? eq(schema.itemParLevels.storageLocationId, params.storageLocationId) : undefined,
            params.itemId !== undefined ? eq(schema.itemParLevels.itemId, params.itemId) : undefined,
          ),
        ),
    );
  }

  async deleteLevel(params: DeleteParLevelParams): Promise<void> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx.delete(schema.itemParLevels).where(eq(schema.itemParLevels.id, params.parLevelId)).returning({ id: schema.itemParLevels.id, storageLocationId: schema.itemParLevels.storageLocationId, itemId: schema.itemParLevels.itemId });
      const deleted = rows[0];
      if (!deleted) throw new NotFoundException(LEVEL_NOT_FOUND);

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "item_par_level.deleted", targetType: "item_par_level", targetId: deleted.id, metadata: { storageLocationId: deleted.storageLocationId, itemId: deleted.itemId } },
        tx,
      );
    });
  }

  async listLowStock(params: ListLowStockParams): Promise<LowStockItemRecord[]> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      let locationIds: string[] | undefined;
      if (params.storageLocationId !== undefined) {
        locationIds = [params.storageLocationId];
      } else if (params.branchId !== undefined) {
        const locationRows = await tx.select({ id: schema.storageLocations.id }).from(schema.storageLocations).where(eq(schema.storageLocations.branchId, params.branchId));
        locationIds = locationRows.map((row) => row.id);
        if (locationIds.length === 0) return [];
      }

      const levelRows = await tx.select().from(schema.itemParLevels).where(locationIds !== undefined ? inArray(schema.itemParLevels.storageLocationId, locationIds) : undefined);
      if (levelRows.length === 0) return [];

      const stockRows = await tx
        .select({ storageLocationId: schema.stockLevels.storageLocationId, itemId: schema.stockLevels.itemId, quantity: schema.stockLevels.quantity })
        .from(schema.stockLevels)
        .where(inArray(schema.stockLevels.storageLocationId, [...new Set(levelRows.map((row) => row.storageLocationId))]));
      const quantityByKey = new Map(stockRows.map((row) => [`${row.storageLocationId}:${row.itemId}`, row.quantity]));

      const lowStock: LowStockItemRecord[] = [];
      for (const level of levelRows) {
        const quantity = quantityByKey.get(`${level.storageLocationId}:${level.itemId}`) ?? 0;
        if (quantity <= level.minQuantity) {
          lowStock.push({ storageLocationId: level.storageLocationId, itemId: level.itemId, quantity, minQuantity: level.minQuantity, parQuantity: level.parQuantity });
        }
      }
      return lowStock;
    });
  }
}
