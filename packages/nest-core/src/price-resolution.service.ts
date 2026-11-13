import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, isNull, lte, or } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE } from "./db.module.js";
import type { OrderType } from "./price-lists.service.js";

export interface ResolvePriceParams {
  restaurantId: string;
  branchId: string;
  orderType: OrderType;
  productId?: string;
  variantId?: string;
  modifierOptionId?: string;
  at?: Date;
}

export interface ResolvedPriceRecord {
  priceListId: string;
  priceListName: string;
  version: number;
  currency: string;
  unitPriceMinor: bigint;
}

const EXACTLY_ONE_REFERENCE = "exactly one of productId, variantId or modifierOptionId must be set";

/**
 * P2-04's actual pricing lookup: given where/when/what, finds the single best-
 * matching *published* price list and returns its price for that product,
 * variant, or (since P2-12) modifier option — null if nothing matches (no
 * price has been set up for this combination at all, not an error). This is
 * what P2-18 (invoice generation), the admin preview endpoint, and P2-12's
 * cart all call; it never mutates anything, so unlike PriceListsService/
 * PriceListItemsService there's no draft/published distinction to enforce
 * here beyond only ever looking at published rows.
 *
 * Tie-break order when more than one published list matches the same moment
 * (e.g. a branch-specific "Happy Hour" list and the year-round "Standard"
 * list both covering 4pm on a Tuesday): explicit `priority` first, then the
 * more specifically-scoped list (branch and/or order type set, rather than
 * "applies everywhere"), then whichever was published most recently.
 */
@Injectable()
export class PriceResolutionService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async resolvePrice(params: ResolvePriceParams): Promise<ResolvedPriceRecord | null> {
    const referenceCount = [params.productId, params.variantId, params.modifierOptionId].filter((v) => v !== undefined).length;
    if (referenceCount !== 1) {
      throw new BadRequestException(EXACTLY_ONE_REFERENCE);
    }
    const at = params.at ?? new Date();

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const itemMatch =
        params.productId !== undefined
          ? eq(schema.priceListItems.productId, params.productId)
          : params.variantId !== undefined
            ? eq(schema.priceListItems.variantId, params.variantId)
            : eq(schema.priceListItems.modifierOptionId, params.modifierOptionId!);

      const rows = await tx
        .select({
          priceListId: schema.priceLists.id,
          priceListName: schema.priceLists.name,
          version: schema.priceLists.version,
          currency: schema.priceLists.currency,
          branchId: schema.priceLists.branchId,
          orderType: schema.priceLists.orderType,
          priority: schema.priceLists.priority,
          publishedAt: schema.priceLists.publishedAt,
          unitPriceMinor: schema.priceListItems.unitPriceMinor,
        })
        .from(schema.priceListItems)
        .innerJoin(schema.priceLists, eq(schema.priceListItems.priceListId, schema.priceLists.id))
        .where(
          and(
            eq(schema.priceLists.status, "published"),
            itemMatch,
            or(isNull(schema.priceLists.branchId), eq(schema.priceLists.branchId, params.branchId)),
            or(isNull(schema.priceLists.orderType), eq(schema.priceLists.orderType, params.orderType)),
            or(isNull(schema.priceLists.effectiveFrom), lte(schema.priceLists.effectiveFrom, at)),
            or(isNull(schema.priceLists.effectiveTo), gte(schema.priceLists.effectiveTo, at)),
          ),
        );

      if (rows.length === 0) return null;

      const [best] = rows.sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        const specificityA = (a.branchId !== null ? 1 : 0) + (a.orderType !== null ? 1 : 0);
        const specificityB = (b.branchId !== null ? 1 : 0) + (b.orderType !== null ? 1 : 0);
        if (specificityA !== specificityB) return specificityB - specificityA;
        return (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0);
      });
      if (!best) return null;

      return {
        priceListId: best.priceListId,
        priceListName: best.priceListName,
        version: best.version,
        currency: best.currency,
        unitPriceMinor: best.unitPriceMinor,
      };
    });
  }
}
