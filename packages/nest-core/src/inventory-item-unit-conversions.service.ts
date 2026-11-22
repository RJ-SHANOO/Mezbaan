import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { convertQuantity } from "@mezbaan/domain";
import { and, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface UnitConversionRecord {
  id: string;
  itemId: string;
  unitId: string;
  factorToBaseUnit: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SetUnitConversionParams {
  restaurantId: string;
  actorUserId: string;
  itemId: string;
  unitId: string;
  factorToBaseUnit: number;
}

export interface ConvertItemQuantityParams {
  restaurantId: string;
  itemId: string;
  quantity: number;
  fromUnitId: string;
  toUnitId: string;
}

const ITEM_NOT_FOUND = "Inventory item not found";
const UNIT_NOT_FOUND = "Unit not found";
const CANNOT_CONVERT_BASE_UNIT = "the item's own base unit can't have its own conversion row — it's always factor 1 by definition";

/**
 * P3-08: per-item alternate-unit conversion factors (inventory_item_unit_
 * conversions) and the actual conversion math (packages/domain's
 * convertQuantity, rule 5's "shared math lives in domain" reasoning
 * applied to quantity the same way it already is to money). `setFactor`
 * is an upsert — same idempotent-attach reasoning as
 * ProductsService.attachModifierGroup, keyed by the table's own (itemId,
 * unitId) unique index.
 */
@Injectable()
export class InventoryItemUnitConversionsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string, itemId: string): Promise<UnitConversionRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) => tx.select().from(schema.inventoryItemUnitConversions).where(eq(schema.inventoryItemUnitConversions.itemId, itemId)));
  }

  async setFactor(params: SetUnitConversionParams): Promise<UnitConversionRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const itemRows = await tx.select({ baseUnitId: schema.inventoryItems.baseUnitId }).from(schema.inventoryItems).where(eq(schema.inventoryItems.id, params.itemId));
      const item = itemRows[0];
      if (!item) throw new NotFoundException(ITEM_NOT_FOUND);
      if (item.baseUnitId === params.unitId) throw new BadRequestException(CANNOT_CONVERT_BASE_UNIT);

      const unitRows = await tx.select({ id: schema.units.id }).from(schema.units).where(eq(schema.units.id, params.unitId));
      if (unitRows.length === 0) throw new NotFoundException(UNIT_NOT_FOUND);

      const existingRows = await tx
        .select()
        .from(schema.inventoryItemUnitConversions)
        .where(and(eq(schema.inventoryItemUnitConversions.itemId, params.itemId), eq(schema.inventoryItemUnitConversions.unitId, params.unitId)));
      const existing = existingRows[0];

      const rows = existing
        ? await tx
            .update(schema.inventoryItemUnitConversions)
            .set({ factorToBaseUnit: params.factorToBaseUnit, updatedAt: new Date() })
            .where(eq(schema.inventoryItemUnitConversions.id, existing.id))
            .returning()
        : await tx
            .insert(schema.inventoryItemUnitConversions)
            .values({ restaurantId: params.restaurantId, itemId: params.itemId, unitId: params.unitId, factorToBaseUnit: params.factorToBaseUnit })
            .returning();
      const conversion = rows[0];
      if (!conversion) throw new Error("setFactor: upsert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "inventory_item_unit_conversion.set",
          targetType: "inventory_item_unit_conversion",
          targetId: conversion.id,
          metadata: { itemId: params.itemId, unitId: params.unitId, factorToBaseUnit: params.factorToBaseUnit },
        },
        tx,
      );
      return conversion;
    });
  }

  /** Converts a quantity between any two of one item's own units, via its
   * base unit — see packages/domain's convertQuantity for the actual math. */
  async convert(params: ConvertItemQuantityParams): Promise<number> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const itemRows = await tx.select({ baseUnitId: schema.inventoryItems.baseUnitId }).from(schema.inventoryItems).where(eq(schema.inventoryItems.id, params.itemId));
      const item = itemRows[0];
      if (!item) throw new NotFoundException(ITEM_NOT_FOUND);

      const conversionRows = await tx.select().from(schema.inventoryItemUnitConversions).where(eq(schema.inventoryItemUnitConversions.itemId, params.itemId));
      const factors = new Map(conversionRows.map((row) => [row.unitId, row.factorToBaseUnit]));

      try {
        return convertQuantity(params.quantity, params.fromUnitId, params.toUnitId, item.baseUnitId, factors);
      } catch (error) {
        // convertQuantity throws a plain Error for an unregistered unit —
        // surface it as a client error (unknown unit for this item), not
        // an unhandled 500 (rule 16: never swallow, show a clear next step).
        throw new BadRequestException(error instanceof Error ? error.message : "Couldn't convert between those units for this item");
      }
    });
  }
}
