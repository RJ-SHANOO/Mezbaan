import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq, inArray } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface InventoryItemRecord {
  id: string;
  categoryId: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  baseUnitId: string;
  purchaseUnitId: string | null;
  status: "active" | "inactive";
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateInventoryItemParams {
  restaurantId: string;
  actorUserId: string;
  categoryId: string;
  name: string;
  sku?: string;
  barcode?: string;
  baseUnitId: string;
  purchaseUnitId?: string;
}

export interface UpdateInventoryItemParams {
  restaurantId: string;
  itemId: string;
  actorUserId: string;
  categoryId?: string;
  name?: string;
  sku?: string | null;
  barcode?: string | null;
  baseUnitId?: string;
  purchaseUnitId?: string | null;
  status?: "active" | "inactive";
}

const ITEM_NOT_FOUND = "Inventory item not found";
const CATEGORY_NOT_FOUND = "Inventory category not found";
const UNIT_NOT_FOUND = "Unit not found";

/**
 * P3-07: CRUD for inventory (raw-ingredient/stock) items — same reference
 * pattern as ProductsService (P2-01), a separate catalog from it (see
 * inventory-items.ts's own docs). SKU/barcode uniqueness is enforced by
 * the DB's own partial unique indexes (inventory-items.ts), same as
 * products.ts — a conflicting insert/update surfaces as a plain Postgres
 * error here rather than a pre-checked, friendlier message, same tradeoff
 * ProductsService already made.
 */
@Injectable()
export class InventoryItemsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string, categoryId?: string): Promise<InventoryItemRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) => {
      const query = tx.select().from(schema.inventoryItems).orderBy(asc(schema.inventoryItems.name));
      return categoryId ? query.where(eq(schema.inventoryItems.categoryId, categoryId)) : query;
    });
  }

  async create(params: CreateInventoryItemParams): Promise<InventoryItemRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const categoryRows = await tx.select({ id: schema.inventoryCategories.id }).from(schema.inventoryCategories).where(eq(schema.inventoryCategories.id, params.categoryId));
      if (categoryRows.length === 0) throw new NotFoundException(CATEGORY_NOT_FOUND);

      const unitIds = [params.baseUnitId, ...(params.purchaseUnitId !== undefined ? [params.purchaseUnitId] : [])];
      const unitRows = await tx.select({ id: schema.units.id }).from(schema.units).where(inArray(schema.units.id, unitIds));
      if (unitRows.length !== new Set(unitIds).size) throw new NotFoundException(UNIT_NOT_FOUND);

      const rows = await tx
        .insert(schema.inventoryItems)
        .values({
          restaurantId: params.restaurantId,
          categoryId: params.categoryId,
          name: params.name,
          sku: params.sku ?? null,
          barcode: params.barcode ?? null,
          baseUnitId: params.baseUnitId,
          purchaseUnitId: params.purchaseUnitId ?? null,
        })
        .returning();
      const item = rows[0];
      if (!item) throw new Error("create: inventory item insert returned no row");

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "inventory_item.created", targetType: "inventory_item", targetId: item.id },
        tx,
      );
      return item;
    });
  }

  async update(params: UpdateInventoryItemParams): Promise<InventoryItemRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      if (params.categoryId !== undefined) {
        const categoryRows = await tx.select({ id: schema.inventoryCategories.id }).from(schema.inventoryCategories).where(eq(schema.inventoryCategories.id, params.categoryId));
        if (categoryRows.length === 0) throw new NotFoundException(CATEGORY_NOT_FOUND);
      }

      const unitIdsToCheck = [params.baseUnitId, ...(params.purchaseUnitId !== undefined && params.purchaseUnitId !== null ? [params.purchaseUnitId] : [])].filter(
        (id): id is string => id !== undefined,
      );
      if (unitIdsToCheck.length > 0) {
        const unitRows = await tx.select({ id: schema.units.id }).from(schema.units).where(inArray(schema.units.id, unitIdsToCheck));
        if (unitRows.length !== new Set(unitIdsToCheck).size) throw new NotFoundException(UNIT_NOT_FOUND);
      }

      const rows = await tx
        .update(schema.inventoryItems)
        .set({
          ...(params.categoryId !== undefined && { categoryId: params.categoryId }),
          ...(params.name !== undefined && { name: params.name }),
          ...(params.sku !== undefined && { sku: params.sku }),
          ...(params.barcode !== undefined && { barcode: params.barcode }),
          ...(params.baseUnitId !== undefined && { baseUnitId: params.baseUnitId }),
          ...(params.purchaseUnitId !== undefined && { purchaseUnitId: params.purchaseUnitId }),
          ...(params.status !== undefined && { status: params.status }),
          updatedAt: new Date(),
        })
        .where(eq(schema.inventoryItems.id, params.itemId))
        .returning();
      const item = rows[0];
      if (!item) throw new NotFoundException(ITEM_NOT_FOUND);

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "inventory_item.updated", targetType: "inventory_item", targetId: item.id },
        tx,
      );
      return item;
    });
  }
}
