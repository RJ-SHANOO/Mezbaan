import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface PriceListItemRecord {
  id: string;
  priceListId: string;
  productId: string | null;
  variantId: string | null;
  modifierOptionId: string | null;
  unitPriceMinor: bigint;
}

export interface SetPriceListItemParams {
  restaurantId: string;
  actorUserId: string;
  priceListId: string;
  productId?: string;
  variantId?: string;
  modifierOptionId?: string;
  unitPriceMinor: bigint;
}

export interface RemovePriceListItemParams {
  restaurantId: string;
  actorUserId: string;
  priceListId: string;
  itemId: string;
}

const PRICE_LIST_NOT_FOUND = "Price list not found";
const ITEM_NOT_FOUND = "Price list item not found";
const PRODUCT_NOT_FOUND = "Product not found";
const VARIANT_NOT_FOUND = "Product variant not found";
const MODIFIER_OPTION_NOT_FOUND = "Modifier option not found";
const EXACTLY_ONE_REFERENCE = "exactly one of productId, variantId or modifierOptionId must be set";
const ONLY_DRAFT_EDITABLE = "only a draft price list's items can be changed";

/**
 * Mutates price_list_items — gated on the same "only while draft" rule as
 * PriceListsService.update, since a published price list's items are the
 * actual versioned, immutable thing P2-04 exists to guarantee. Setting a
 * price is an upsert (matching products.ts/modifier-groups.ts' other
 * attach-style operations): calling it again for the same product/variant/
 * modifier option in the same price list updates the existing row instead
 * of erroring or duplicating it. modifierOptionId (P2-12) completes what
 * modifier-options.ts already said was the plan.
 */
@Injectable()
export class PriceListItemsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string, priceListId: string): Promise<PriceListItemRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) => tx.select().from(schema.priceListItems).where(eq(schema.priceListItems.priceListId, priceListId)));
  }

  async setPrice(params: SetPriceListItemParams): Promise<PriceListItemRecord> {
    const referenceCount = [params.productId, params.variantId, params.modifierOptionId].filter((v) => v !== undefined).length;
    if (referenceCount !== 1) {
      throw new BadRequestException(EXACTLY_ONE_REFERENCE);
    }

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const priceListRows = await tx.select().from(schema.priceLists).where(eq(schema.priceLists.id, params.priceListId));
      const priceList = priceListRows[0];
      if (!priceList) throw new NotFoundException(PRICE_LIST_NOT_FOUND);
      if (priceList.status !== "draft") throw new BadRequestException(ONLY_DRAFT_EDITABLE);

      if (params.productId !== undefined) {
        const rows = await tx.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.id, params.productId));
        if (rows.length === 0) throw new NotFoundException(PRODUCT_NOT_FOUND);
      } else if (params.variantId !== undefined) {
        const rows = await tx.select({ id: schema.productVariants.id }).from(schema.productVariants).where(eq(schema.productVariants.id, params.variantId));
        if (rows.length === 0) throw new NotFoundException(VARIANT_NOT_FOUND);
      } else {
        const rows = await tx
          .select({ id: schema.modifierOptions.id })
          .from(schema.modifierOptions)
          .where(eq(schema.modifierOptions.id, params.modifierOptionId!));
        if (rows.length === 0) throw new NotFoundException(MODIFIER_OPTION_NOT_FOUND);
      }

      const matchCondition =
        params.productId !== undefined
          ? and(eq(schema.priceListItems.priceListId, params.priceListId), eq(schema.priceListItems.productId, params.productId))
          : params.variantId !== undefined
            ? and(eq(schema.priceListItems.priceListId, params.priceListId), eq(schema.priceListItems.variantId, params.variantId))
            : and(eq(schema.priceListItems.priceListId, params.priceListId), eq(schema.priceListItems.modifierOptionId, params.modifierOptionId!));
      const existingRows = await tx.select().from(schema.priceListItems).where(matchCondition);
      const existing = existingRows[0];

      const item = existing
        ? (
            await tx
              .update(schema.priceListItems)
              .set({ unitPriceMinor: params.unitPriceMinor, updatedAt: new Date() })
              .where(eq(schema.priceListItems.id, existing.id))
              .returning()
          )[0]
        : (
            await tx
              .insert(schema.priceListItems)
              .values({
                restaurantId: params.restaurantId,
                priceListId: params.priceListId,
                productId: params.productId ?? null,
                variantId: params.variantId ?? null,
                modifierOptionId: params.modifierOptionId ?? null,
                unitPriceMinor: params.unitPriceMinor,
              })
              .returning()
          )[0];
      if (!item) throw new Error("setPrice: price list item write returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "price_list_item.set",
          targetType: "price_list",
          targetId: params.priceListId,
          metadata: {
            productId: params.productId,
            variantId: params.variantId,
            modifierOptionId: params.modifierOptionId,
            unitPriceMinor: params.unitPriceMinor.toString(),
          },
        },
        tx,
      );
      return item;
    });
  }

  async removePrice(params: RemovePriceListItemParams): Promise<void> {
    await withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const priceListRows = await tx.select().from(schema.priceLists).where(eq(schema.priceLists.id, params.priceListId));
      const priceList = priceListRows[0];
      if (!priceList) throw new NotFoundException(PRICE_LIST_NOT_FOUND);
      if (priceList.status !== "draft") throw new BadRequestException(ONLY_DRAFT_EDITABLE);

      const deletedRows = await tx
        .delete(schema.priceListItems)
        .where(and(eq(schema.priceListItems.id, params.itemId), eq(schema.priceListItems.priceListId, params.priceListId)))
        .returning({ id: schema.priceListItems.id });
      if (deletedRows.length === 0) throw new NotFoundException(ITEM_NOT_FOUND);

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "price_list_item.removed", targetType: "price_list", targetId: params.priceListId },
        tx,
      );
    });
  }
}
