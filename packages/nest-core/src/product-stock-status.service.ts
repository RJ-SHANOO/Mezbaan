import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface ProductStockStatusRecord {
  id: string;
  branchId: string;
  productId: string | null;
  variantId: string | null;
  reason: string | null;
  markedByUserId: string;
  markedAt: Date;
}

export interface MarkOutOfStockParams {
  restaurantId: string;
  actorUserId: string;
  branchId: string;
  productId?: string;
  variantId?: string;
  reason?: string;
}

export interface ClearOutOfStockParams {
  restaurantId: string;
  actorUserId: string;
  branchId: string;
  productId?: string;
  variantId?: string;
}

export interface ListOutOfStockParams {
  restaurantId: string;
  branchId?: string;
}

const EXACTLY_ONE_REFERENCE = "exactly one of productId or variantId must be set";
const MARKING_NOT_FOUND = "This item isn't currently marked out of stock at that branch";

/**
 * P2-06's actual state: which products/variants are 86'd at which branch,
 * right now. A row's existence means "out of stock" — same exclusion-list
 * convention as product_branch_availability (P2-01) — so marking twice just
 * refreshes reason/markedAt/markedByUserId (an upsert, same idempotent-attach
 * reasoning as ProductsService.attachModifierGroup) and clearing deletes the
 * row outright. See product-stock-status.ts for why "syncs quickly to
 * terminals and kitchen screens" stops at "this read is always current" for
 * now — there's no push transport or kitchen screen to land on yet.
 */
@Injectable()
export class ProductStockStatusService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(params: ListOutOfStockParams): Promise<ProductStockStatusRecord[]> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.productStockStatus)
        .where(params.branchId !== undefined ? eq(schema.productStockStatus.branchId, params.branchId) : undefined)
        .orderBy(desc(schema.productStockStatus.markedAt)),
    );
  }

  async markOutOfStock(params: MarkOutOfStockParams): Promise<ProductStockStatusRecord> {
    if ((params.productId === undefined) === (params.variantId === undefined)) {
      throw new BadRequestException(EXACTLY_ONE_REFERENCE);
    }

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const branchRows = await tx.select({ id: schema.branches.id }).from(schema.branches).where(eq(schema.branches.id, params.branchId));
      if (branchRows.length === 0) throw new NotFoundException("Branch not found");

      if (params.productId !== undefined) {
        const productRows = await tx.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.id, params.productId));
        if (productRows.length === 0) throw new NotFoundException("Product not found");
      } else {
        const variantRows = await tx
          .select({ id: schema.productVariants.id })
          .from(schema.productVariants)
          .where(eq(schema.productVariants.id, params.variantId!));
        if (variantRows.length === 0) throw new NotFoundException("Product variant not found");
      }

      const scopeMatch =
        params.productId !== undefined
          ? and(eq(schema.productStockStatus.branchId, params.branchId), eq(schema.productStockStatus.productId, params.productId))
          : and(eq(schema.productStockStatus.branchId, params.branchId), eq(schema.productStockStatus.variantId, params.variantId!));
      const existingRows = await tx.select().from(schema.productStockStatus).where(scopeMatch);
      const existing = existingRows[0];

      const rows = existing
        ? await tx
            .update(schema.productStockStatus)
            .set({ reason: params.reason ?? null, markedByUserId: params.actorUserId, markedAt: new Date() })
            .where(eq(schema.productStockStatus.id, existing.id))
            .returning()
        : await tx
            .insert(schema.productStockStatus)
            .values({
              restaurantId: params.restaurantId,
              branchId: params.branchId,
              productId: params.productId ?? null,
              variantId: params.variantId ?? null,
              reason: params.reason ?? null,
              markedByUserId: params.actorUserId,
            })
            .returning();
      const marking = rows[0];
      if (!marking) throw new Error("markOutOfStock: upsert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "product_stock_status.marked",
          targetType: "product_stock_status",
          targetId: marking.id,
          metadata: { branchId: marking.branchId, productId: marking.productId, variantId: marking.variantId, reason: marking.reason },
        },
        tx,
      );
      return marking;
    });
  }

  async clearOutOfStock(params: ClearOutOfStockParams): Promise<void> {
    if ((params.productId === undefined) === (params.variantId === undefined)) {
      throw new BadRequestException(EXACTLY_ONE_REFERENCE);
    }

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const scopeMatch =
        params.productId !== undefined
          ? and(eq(schema.productStockStatus.branchId, params.branchId), eq(schema.productStockStatus.productId, params.productId))
          : and(eq(schema.productStockStatus.branchId, params.branchId), eq(schema.productStockStatus.variantId, params.variantId!));

      const rows = await tx.delete(schema.productStockStatus).where(scopeMatch).returning();
      const marking = rows[0];
      if (!marking) throw new NotFoundException(MARKING_NOT_FOUND);

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "product_stock_status.cleared",
          targetType: "product_stock_status",
          targetId: marking.id,
          metadata: { branchId: marking.branchId, productId: marking.productId, variantId: marking.variantId },
        },
        tx,
      );
    });
  }
}
