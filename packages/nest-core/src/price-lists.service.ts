import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export type OrderType = "dine_in" | "takeaway" | "delivery";

export interface PriceListRecord {
  id: string;
  name: string;
  version: number;
  currency: string;
  branchId: string | null;
  orderType: OrderType | null;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  priority: number;
  status: "draft" | "published" | "archived";
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePriceListParams {
  restaurantId: string;
  actorUserId: string;
  name: string;
  currency: string;
  branchId?: string;
  orderType?: OrderType;
  effectiveFrom?: string;
  effectiveTo?: string;
  priority?: number;
}

export interface UpdatePriceListParams {
  restaurantId: string;
  priceListId: string;
  actorUserId: string;
  name?: string;
  branchId?: string | null;
  orderType?: OrderType | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  priority?: number;
}

export interface PriceListActionParams {
  restaurantId: string;
  priceListId: string;
  actorUserId: string;
}

const PRICE_LIST_NOT_FOUND = "Price list not found";
const ONLY_DRAFT_EDITABLE = "only a draft price list can be edited";
const ONLY_DRAFT_PUBLISHABLE = "only a draft price list can be published";
const CANNOT_PUBLISH_EMPTY = "a price list needs at least one priced item before it can be published";
const ALREADY_ARCHIVED = "this price list is already archived";

/**
 * Same CRUD reference pattern as CategoriesService, plus the actual point of
 * "versioned" (P2-04): once published, a price list and its items are never
 * mutated again — update()/PriceListItemsService's mutations both refuse to
 * touch anything that isn't still a draft. A price change is always a new
 * price list row (a new version), never an edit to an old one.
 */
@Injectable()
export class PriceListsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string): Promise<PriceListRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) => tx.select().from(schema.priceLists).orderBy(asc(schema.priceLists.createdAt)));
  }

  async create(params: CreatePriceListParams): Promise<PriceListRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      if (params.branchId !== undefined) {
        const branchRows = await tx.select({ id: schema.branches.id }).from(schema.branches).where(eq(schema.branches.id, params.branchId));
        if (branchRows.length === 0) throw new NotFoundException("Branch not found");
      }

      const rows = await tx
        .insert(schema.priceLists)
        .values({
          restaurantId: params.restaurantId,
          name: params.name,
          currency: params.currency,
          branchId: params.branchId ?? null,
          orderType: params.orderType ?? null,
          effectiveFrom: params.effectiveFrom ? new Date(params.effectiveFrom) : null,
          effectiveTo: params.effectiveTo ? new Date(params.effectiveTo) : null,
          priority: params.priority ?? 0,
        })
        .returning();
      const priceList = rows[0];
      if (!priceList) throw new Error("create: price list insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "price_list.created",
          targetType: "price_list",
          targetId: priceList.id,
          metadata: { name: priceList.name, version: priceList.version },
        },
        tx,
      );
      return priceList;
    });
  }

  async update(params: UpdatePriceListParams): Promise<PriceListRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const existingRows = await tx.select().from(schema.priceLists).where(eq(schema.priceLists.id, params.priceListId));
      const existing = existingRows[0];
      if (!existing) throw new NotFoundException(PRICE_LIST_NOT_FOUND);
      if (existing.status !== "draft") throw new BadRequestException(ONLY_DRAFT_EDITABLE);

      if (params.branchId) {
        const branchRows = await tx.select({ id: schema.branches.id }).from(schema.branches).where(eq(schema.branches.id, params.branchId));
        if (branchRows.length === 0) throw new NotFoundException("Branch not found");
      }

      const rows = await tx
        .update(schema.priceLists)
        .set({
          ...(params.name !== undefined && { name: params.name }),
          ...(params.branchId !== undefined && { branchId: params.branchId }),
          ...(params.orderType !== undefined && { orderType: params.orderType }),
          ...(params.effectiveFrom !== undefined && { effectiveFrom: params.effectiveFrom ? new Date(params.effectiveFrom) : null }),
          ...(params.effectiveTo !== undefined && { effectiveTo: params.effectiveTo ? new Date(params.effectiveTo) : null }),
          ...(params.priority !== undefined && { priority: params.priority }),
          updatedAt: new Date(),
        })
        .where(eq(schema.priceLists.id, params.priceListId))
        .returning();
      const priceList = rows[0];
      if (!priceList) throw new NotFoundException(PRICE_LIST_NOT_FOUND);

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "price_list.updated", targetType: "price_list", targetId: priceList.id },
        tx,
      );
      return priceList;
    });
  }

  async publish(params: PriceListActionParams): Promise<PriceListRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const existingRows = await tx.select().from(schema.priceLists).where(eq(schema.priceLists.id, params.priceListId));
      const existing = existingRows[0];
      if (!existing) throw new NotFoundException(PRICE_LIST_NOT_FOUND);
      if (existing.status !== "draft") throw new BadRequestException(ONLY_DRAFT_PUBLISHABLE);

      const itemRows = await tx.select({ id: schema.priceListItems.id }).from(schema.priceListItems).where(eq(schema.priceListItems.priceListId, params.priceListId));
      if (itemRows.length === 0) throw new BadRequestException(CANNOT_PUBLISH_EMPTY);

      const rows = await tx
        .update(schema.priceLists)
        .set({ status: "published", publishedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.priceLists.id, params.priceListId))
        .returning();
      const priceList = rows[0];
      if (!priceList) throw new NotFoundException(PRICE_LIST_NOT_FOUND);

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "price_list.published",
          targetType: "price_list",
          targetId: priceList.id,
          metadata: { name: priceList.name, version: priceList.version },
        },
        tx,
      );
      return priceList;
    });
  }

  async archive(params: PriceListActionParams): Promise<PriceListRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const existingRows = await tx.select().from(schema.priceLists).where(eq(schema.priceLists.id, params.priceListId));
      const existing = existingRows[0];
      if (!existing) throw new NotFoundException(PRICE_LIST_NOT_FOUND);
      if (existing.status === "archived") throw new BadRequestException(ALREADY_ARCHIVED);

      const rows = await tx
        .update(schema.priceLists)
        .set({ status: "archived", updatedAt: new Date() })
        .where(eq(schema.priceLists.id, params.priceListId))
        .returning();
      const priceList = rows[0];
      if (!priceList) throw new NotFoundException(PRICE_LIST_NOT_FOUND);

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "price_list.archived", targetType: "price_list", targetId: priceList.id },
        tx,
      );
      return priceList;
    });
  }
}
