import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export interface KitchenRoutingRuleRecord {
  id: string;
  branchId: string;
  stationId: string;
  categoryId: string | null;
  productId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateKitchenRoutingRuleParams {
  restaurantId: string;
  actorUserId: string;
  branchId: string;
  stationId: string;
  categoryId?: string;
  productId?: string;
}

export interface UpdateKitchenRoutingRuleParams {
  restaurantId: string;
  actorUserId: string;
  ruleId: string;
  stationId: string;
}

export interface ResolveStationParams {
  restaurantId: string;
  branchId: string;
  productId: string;
}

const EXACTLY_ONE_REFERENCE = "exactly one of categoryId or productId must be set";
const RULE_NOT_FOUND = "Kitchen routing rule not found";

/**
 * P3-01: which station a category or product routes to, at one branch. A
 * product-level rule overrides its category's rule — resolveStationForProduct
 * is the read path later consumers (P3-02's kitchen tickets) will call; no
 * such caller exists yet, same "primitive now, real consumer later" split as
 * P1-30's outbox table before a real producer.
 */
@Injectable()
export class KitchenRoutingRulesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string, branchId?: string): Promise<KitchenRoutingRuleRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) =>
      tx
        .select()
        .from(schema.kitchenRoutingRules)
        .where(branchId !== undefined ? eq(schema.kitchenRoutingRules.branchId, branchId) : undefined),
    );
  }

  async create(params: CreateKitchenRoutingRuleParams): Promise<KitchenRoutingRuleRecord> {
    if ((params.categoryId === undefined) === (params.productId === undefined)) {
      throw new BadRequestException(EXACTLY_ONE_REFERENCE);
    }

    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const branchRows = await tx
        .select({ id: schema.branches.id })
        .from(schema.branches)
        .where(and(eq(schema.branches.id, params.branchId), eq(schema.branches.restaurantId, params.restaurantId)));
      if (branchRows.length === 0) throw new NotFoundException("Branch not found");

      const stationRows = await tx
        .select({ id: schema.kitchenStations.id })
        .from(schema.kitchenStations)
        .where(
          and(
            eq(schema.kitchenStations.id, params.stationId),
            eq(schema.kitchenStations.restaurantId, params.restaurantId),
            eq(schema.kitchenStations.branchId, params.branchId),
          ),
        );
      if (stationRows.length === 0) throw new NotFoundException("Kitchen station not found at this branch");

      if (params.categoryId !== undefined) {
        const categoryRows = await tx
          .select({ id: schema.categories.id })
          .from(schema.categories)
          .where(and(eq(schema.categories.id, params.categoryId), eq(schema.categories.restaurantId, params.restaurantId)));
        if (categoryRows.length === 0) throw new NotFoundException("Category not found");
      } else {
        const productRows = await tx
          .select({ id: schema.products.id })
          .from(schema.products)
          .where(and(eq(schema.products.id, params.productId!), eq(schema.products.restaurantId, params.restaurantId)));
        if (productRows.length === 0) throw new NotFoundException("Product not found");
      }

      const rows = await tx
        .insert(schema.kitchenRoutingRules)
        .values({
          restaurantId: params.restaurantId,
          branchId: params.branchId,
          stationId: params.stationId,
          categoryId: params.categoryId ?? null,
          productId: params.productId ?? null,
        })
        .returning();
      const rule = rows[0];
      if (!rule) throw new Error("create: kitchen routing rule insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "kitchen_routing_rule.created",
          targetType: "kitchen_routing_rule",
          targetId: rule.id,
          metadata: { branchId: rule.branchId, stationId: rule.stationId, categoryId: rule.categoryId, productId: rule.productId },
        },
        tx,
      );
      return rule;
    });
  }

  async update(params: UpdateKitchenRoutingRuleParams): Promise<KitchenRoutingRuleRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const stationRows = await tx
        .select({ id: schema.kitchenStations.id })
        .from(schema.kitchenStations)
        .where(and(eq(schema.kitchenStations.id, params.stationId), eq(schema.kitchenStations.restaurantId, params.restaurantId)));
      if (stationRows.length === 0) throw new NotFoundException("Kitchen station not found");

      const rows = await tx
        .update(schema.kitchenRoutingRules)
        .set({ stationId: params.stationId, updatedAt: new Date() })
        .where(and(eq(schema.kitchenRoutingRules.id, params.ruleId), eq(schema.kitchenRoutingRules.restaurantId, params.restaurantId)))
        .returning();
      const rule = rows[0];
      if (!rule) throw new NotFoundException(RULE_NOT_FOUND);

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "kitchen_routing_rule.updated", targetType: "kitchen_routing_rule", targetId: rule.id },
        tx,
      );
      return rule;
    });
  }

  async delete(restaurantId: string, actorUserId: string, ruleId: string): Promise<void> {
    return withTenant(this.db, { restaurantId }, async (tx) => {
      const rows = await tx
        .delete(schema.kitchenRoutingRules)
        .where(and(eq(schema.kitchenRoutingRules.id, ruleId), eq(schema.kitchenRoutingRules.restaurantId, restaurantId)))
        .returning();
      const rule = rows[0];
      if (!rule) throw new NotFoundException(RULE_NOT_FOUND);

      await this.auditLogService.record(
        { restaurantId, actorUserId, action: "kitchen_routing_rule.deleted", targetType: "kitchen_routing_rule", targetId: rule.id },
        tx,
      );
    });
  }

  /** Product-level rule wins over its category's rule; null if neither exists. */
  async resolveStationForProduct(params: ResolveStationParams): Promise<string | null> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const productRows = await tx
        .select({ categoryId: schema.products.categoryId })
        .from(schema.products)
        .where(and(eq(schema.products.id, params.productId), eq(schema.products.restaurantId, params.restaurantId)));
      const product = productRows[0];
      if (!product) throw new NotFoundException("Product not found");

      const productRuleRows = await tx
        .select({ stationId: schema.kitchenRoutingRules.stationId })
        .from(schema.kitchenRoutingRules)
        .where(and(eq(schema.kitchenRoutingRules.branchId, params.branchId), eq(schema.kitchenRoutingRules.productId, params.productId)));
      if (productRuleRows[0]) return productRuleRows[0].stationId;

      const categoryRuleRows = await tx
        .select({ stationId: schema.kitchenRoutingRules.stationId })
        .from(schema.kitchenRoutingRules)
        .where(and(eq(schema.kitchenRoutingRules.branchId, params.branchId), eq(schema.kitchenRoutingRules.categoryId, product.categoryId)));
      return categoryRuleRows[0]?.stationId ?? null;
    });
  }
}
