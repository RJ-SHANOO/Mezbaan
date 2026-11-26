import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { DATABASE } from "./db.module.js";

export type BillingPlanType = "commission_only" | "hybrid";
export type BillingCycle = "weekly" | "biweekly" | "monthly" | "quarterly";

export interface BillingPlanRecord {
  planType: BillingPlanType;
  fixedFeeMinor: bigint | null;
  fixedFeeCurrency: string | null;
  billingCycle: BillingCycle;
}

export interface SetBillingPlanParams {
  restaurantId: string;
  actorUserId: string;
  planType: BillingPlanType;
  fixedFeeMinor?: bigint;
  fixedFeeCurrency?: string;
  billingCycle: BillingCycle;
}

export const DEFAULT_BILLING_PLAN: BillingPlanRecord = {
  planType: "commission_only",
  fixedFeeMinor: null,
  fixedFeeCurrency: null,
  billingCycle: "monthly",
};

/**
 * P3-36: the hybrid fixed-fee + commission plan and configurable billing
 * cycle — same "settings table, absence means the default" convention as
 * DiscountLimitsService/PaymentMethodSettingsService, and the same
 * super-admin-only-write split as FeatureFlagsService (billing plans are a
 * platform decision, not a restaurant self-service setting). See
 * billing-plan-settings.ts for why this is deliberately NOT locked the way
 * restaurants.commissionRateBasisPoints is (rule 7) — P3-37's CommissionRun
 * is what snapshots whichever plan is in effect onto each run.
 */
@Injectable()
export class BillingPlanService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly auditLogService: AuditLogService,
  ) {}

  async getForRestaurant(restaurantId: string): Promise<BillingPlanRecord> {
    return withTenant(this.db, { restaurantId }, (tx) => this.readPlan(tx, restaurantId));
  }

  async getForRestaurantAsSuperAdmin(restaurantId: string): Promise<BillingPlanRecord> {
    return withTenant(this.db, { restaurantId, isSuperAdmin: true }, (tx) => this.readPlan(tx, restaurantId));
  }

  async setPlan(params: SetBillingPlanParams): Promise<BillingPlanRecord> {
    return withTenant(this.db, { restaurantId: params.restaurantId, isSuperAdmin: true }, async (tx) => {
      const values = {
        planType: params.planType,
        fixedFeeMinor: params.fixedFeeMinor ?? null,
        fixedFeeCurrency: params.fixedFeeCurrency ?? null,
        billingCycle: params.billingCycle,
        updatedByUserId: params.actorUserId,
      };

      const rows = await tx
        .insert(schema.billingPlanSettings)
        .values({ restaurantId: params.restaurantId, ...values })
        .onConflictDoUpdate({
          target: schema.billingPlanSettings.restaurantId,
          set: { ...values, updatedAt: new Date() },
        })
        .returning();
      const settings = rows[0];
      if (!settings) throw new Error("setPlan: upsert returned no row");

      await this.auditLogService.record(
        {
          restaurantId: params.restaurantId,
          actorUserId: params.actorUserId,
          action: "billing_plan.set",
          targetType: "billing_plan_settings",
          targetId: settings.id,
          metadata: { planType: params.planType, billingCycle: params.billingCycle, fixedFeeMinor: params.fixedFeeMinor?.toString() ?? null },
        },
        tx,
      );

      return this.toRecord(settings);
    });
  }

  /** `restaurantId` is filtered explicitly here, not left to RLS alone
   * (rule 2: RLS is a second barrier, app code must still filter
   * correctly) — the super-admin caller runs with isSuperAdmin: true,
   * which makes every row of this single-table-no-partition settings
   * table visible to the RLS policy, so without this WHERE clause a
   * super-admin lookup for restaurant A could return restaurant B's plan
   * (whichever row the query happened to return first). */
  private async readPlan(tx: Database, restaurantId: string): Promise<BillingPlanRecord> {
    const rows = await tx
      .select({
        planType: schema.billingPlanSettings.planType,
        fixedFeeMinor: schema.billingPlanSettings.fixedFeeMinor,
        fixedFeeCurrency: schema.billingPlanSettings.fixedFeeCurrency,
        billingCycle: schema.billingPlanSettings.billingCycle,
      })
      .from(schema.billingPlanSettings)
      .where(eq(schema.billingPlanSettings.restaurantId, restaurantId));
    return rows[0] ?? DEFAULT_BILLING_PLAN;
  }

  private toRecord(row: typeof schema.billingPlanSettings.$inferSelect): BillingPlanRecord {
    return { planType: row.planType, fixedFeeMinor: row.fixedFeeMinor, fixedFeeCurrency: row.fixedFeeCurrency, billingCycle: row.billingCycle };
  }
}
