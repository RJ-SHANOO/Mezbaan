import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";
import type { OrderType } from "./price-lists.service.js";

export interface TaxRuleRecord {
  id: string;
  name: string;
  rateBasisPoints: number;
  branchId: string | null;
  orderType: OrderType | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTaxRuleParams {
  restaurantId: string;
  actorUserId: string;
  name: string;
  rateBasisPoints: number;
  branchId?: string;
  orderType?: OrderType;
}

export interface UpdateTaxRuleParams {
  restaurantId: string;
  taxRuleId: string;
  actorUserId: string;
  name?: string;
  rateBasisPoints?: number;
  branchId?: string | null;
  orderType?: OrderType | null;
  isActive?: boolean;
}

export interface ResolveApplicableTaxRulesParams {
  restaurantId: string;
  branchId: string;
  orderType: OrderType;
}

export interface AppliedTaxRule {
  name: string;
  rateBasisPoints: number;
}

const TAX_RULE_NOT_FOUND = "Tax rule not found";

/**
 * Same CRUD reference pattern as CategoriesService, plus the actual pricing
 * logic (P2-05): resolveApplicable sums every active rule that matches a
 * branch/orderType scope, since real tax regimes commonly stack more than
 * one named component (e.g. CGST + SGST) on a single sale — unlike price
 * lists (P2-04), there's no single "best match" to pick. When two active
 * rules share the same name and both match (a restaurant-wide default and a
 * branch-specific override of the same tax), only the more specifically-
 * scoped one counts for that name, so the override replaces the default
 * instead of adding to it.
 */
@Injectable()
export class TaxRulesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async list(restaurantId: string): Promise<TaxRuleRecord[]> {
    return withTenant(this.db, { restaurantId }, (tx) => tx.select().from(schema.taxRules).orderBy(asc(schema.taxRules.createdAt)));
  }

  async create(params: CreateTaxRuleParams): Promise<TaxRuleRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      if (params.branchId !== undefined) {
        const branchRows = await tx.select({ id: schema.branches.id }).from(schema.branches).where(eq(schema.branches.id, params.branchId));
        if (branchRows.length === 0) throw new NotFoundException("Branch not found");
      }

      const rows = await tx
        .insert(schema.taxRules)
        .values({
          restaurantId: params.restaurantId,
          name: params.name,
          rateBasisPoints: params.rateBasisPoints,
          branchId: params.branchId ?? null,
          orderType: params.orderType ?? null,
        })
        .returning();
      const taxRule = rows[0];
      if (!taxRule) throw new Error("create: tax rule insert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "tax_rule.created",
          targetType: "tax_rule",
          targetId: taxRule.id,
          metadata: { name: taxRule.name, rateBasisPoints: taxRule.rateBasisPoints },
        },
        tx,
      );
      return taxRule;
    });
  }

  async update(params: UpdateTaxRuleParams): Promise<TaxRuleRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      if (params.branchId) {
        const branchRows = await tx.select({ id: schema.branches.id }).from(schema.branches).where(eq(schema.branches.id, params.branchId));
        if (branchRows.length === 0) throw new NotFoundException("Branch not found");
      }

      const rows = await tx
        .update(schema.taxRules)
        .set({
          ...(params.name !== undefined && { name: params.name }),
          ...(params.rateBasisPoints !== undefined && { rateBasisPoints: params.rateBasisPoints }),
          ...(params.branchId !== undefined && { branchId: params.branchId }),
          ...(params.orderType !== undefined && { orderType: params.orderType }),
          ...(params.isActive !== undefined && { isActive: params.isActive }),
          updatedAt: new Date(),
        })
        .where(eq(schema.taxRules.id, params.taxRuleId))
        .returning();
      const taxRule = rows[0];
      if (!taxRule) throw new NotFoundException(TAX_RULE_NOT_FOUND);

      await this.auditLogService.record(
        { restaurantId: params.restaurantId, actorUserId: params.actorUserId, action: "tax_rule.updated", targetType: "tax_rule", targetId: taxRule.id },
        tx,
      );
      return taxRule;
    });
  }

  async resolveApplicable(params: ResolveApplicableTaxRulesParams): Promise<AppliedTaxRule[]> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.taxRules)
        .where(
          and(
            eq(schema.taxRules.isActive, true),
            or(isNull(schema.taxRules.branchId), eq(schema.taxRules.branchId, params.branchId)),
            or(isNull(schema.taxRules.orderType), eq(schema.taxRules.orderType, params.orderType)),
          ),
        );

      const bestByName = new Map<string, (typeof rows)[number]>();
      for (const row of rows) {
        const existing = bestByName.get(row.name);
        if (!existing || specificity(row) > specificity(existing)) {
          bestByName.set(row.name, row);
        }
      }
      return [...bestByName.values()].map((row) => ({ name: row.name, rateBasisPoints: row.rateBasisPoints }));
    });
  }
}

function specificity(row: { branchId: string | null; orderType: string | null }): number {
  return (row.branchId !== null ? 1 : 0) + (row.orderType !== null ? 1 : 0);
}
