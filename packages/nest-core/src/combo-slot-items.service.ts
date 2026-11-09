import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface ComboSlotItemRecord {
  id: string;
  comboSlotId: string;
  productId: string;
  sortOrder: number;
}

export interface AttachComboSlotItemParams {
  restaurantId: string;
  actorUserId: string;
  comboSlotId: string;
  productId: string;
  sortOrder?: number;
}

export interface DetachComboSlotItemParams {
  restaurantId: string;
  actorUserId: string;
  comboSlotId: string;
  productId: string;
}

const SLOT_NOT_FOUND = "Combo slot not found";
const PRODUCT_NOT_FOUND = "Product not found";
const FIXED_SLOT_SINGLE_ITEM = "a fixed slot can only ever have one item";

/** Same reference pattern as ProductsService's modifier-group attach/detach
 * (P2-02): attaching the same product again is an idempotent sortOrder
 * update, not a duplicate. The one thing specific to combos: a "fixed" slot
 * (P2-03) is only ever allowed exactly one item — attaching a second,
 * different product to it is rejected outright. */
@Injectable()
export class ComboSlotItemsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string, comboSlotId: string): Promise<ComboSlotItemRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) =>
      tx.select().from(schema.comboSlotItems).where(eq(schema.comboSlotItems.comboSlotId, comboSlotId)).orderBy(asc(schema.comboSlotItems.sortOrder)),
    );
  }

  async attach(params: AttachComboSlotItemParams): Promise<ComboSlotItemRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const slotRows = await tx.select().from(schema.comboSlots).where(eq(schema.comboSlots.id, params.comboSlotId));
      const slot = slotRows[0];
      if (!slot) throw new NotFoundException(SLOT_NOT_FOUND);

      const productRows = await tx.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.id, params.productId));
      if (productRows.length === 0) throw new NotFoundException(PRODUCT_NOT_FOUND);

      if (slot.kind === "fixed") {
        const existingItems = await tx.select().from(schema.comboSlotItems).where(eq(schema.comboSlotItems.comboSlotId, params.comboSlotId));
        const other = existingItems.find((item) => item.productId !== params.productId);
        if (other) throw new BadRequestException(FIXED_SLOT_SINGLE_ITEM);
      }

      const rows = await tx
        .insert(schema.comboSlotItems)
        .values({ restaurantId: params.restaurantId, comboSlotId: params.comboSlotId, productId: params.productId, sortOrder: params.sortOrder ?? 0 })
        .onConflictDoUpdate({
          target: [schema.comboSlotItems.comboSlotId, schema.comboSlotItems.productId],
          set: { sortOrder: params.sortOrder ?? 0 },
        })
        .returning();
      const item = rows[0];
      if (!item) throw new Error("attach: combo slot item insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "combo_slot_item.attached",
          targetType: "combo_slot",
          targetId: params.comboSlotId,
          metadata: { productId: params.productId },
        },
        tx,
      );
      return item;
    });
  }

  async detach(params: DetachComboSlotItemParams): Promise<void> {
    await withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      await tx
        .delete(schema.comboSlotItems)
        .where(and(eq(schema.comboSlotItems.comboSlotId, params.comboSlotId), eq(schema.comboSlotItems.productId, params.productId)));

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "combo_slot_item.detached",
          targetType: "combo_slot",
          targetId: params.comboSlotId,
          metadata: { productId: params.productId },
        },
        tx,
      );
    });
  }
}
