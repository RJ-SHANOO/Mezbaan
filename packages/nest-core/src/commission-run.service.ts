import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { billingPeriodContaining, type BillingPeriod } from "@mezbaan/domain";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { AuditLogService } from "./audit-log.service.js";
import { BillingPlanService, type BillingPlanRecord } from "./billing-plan.service.js";
import { DATABASE } from "./db.module.js";
import { SettlementStatementsService } from "./settlement-statements.service.js";

export type CommissionRunRecord = typeof schema.commissionRuns.$inferSelect;

/**
 * P3-37: advances every restaurant through its own billing periods,
 * creating one commission_runs row per (period, currency) actually
 * settled. Idempotent via commission-run-cursors.ts's sequential cursor —
 * see that file and commission-runs.ts for the full reasoning. Driven by
 * CommissionRunScheduler (apps/worker) nightly; also directly callable
 * (e.g. for a manual catch-up run or a future admin "run now" action).
 *
 * A failure processing one restaurant must never stop the rest (rule 13) —
 * `runAll` logs and continues; a failure mid-restaurant simply leaves that
 * restaurant's cursor wherever it last successfully committed, so the next
 * run picks up from there with no lost or duplicated period.
 *
 * P3-38: every run this service creates also gets its 1:1 settlement
 * statement in the very same transaction — see
 * SettlementStatementsService.createForRunInTx and settlement-statements.ts
 * for why that's a separate table rather than just a restaurant-facing view
 * of commission_runs.
 */
@Injectable()
export class CommissionRunService {
  private readonly logger = new Logger(CommissionRunService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly billingPlanService: BillingPlanService,
    private readonly auditLogService: AuditLogService,
    private readonly settlementStatementsService: SettlementStatementsService,
  ) {}

  async runAll(asOf: Date = new Date()): Promise<void> {
    const restaurantIds = await this.listActiveRestaurantIds();
    for (const restaurantId of restaurantIds) {
      try {
        await this.runForRestaurant(restaurantId, asOf);
      } catch (error) {
        this.logger.error(`commission run failed for restaurant ${restaurantId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Processes every period that has fully elapsed by `asOf` and hasn't
   * been processed yet for this restaurant, one transaction per period. */
  async runForRestaurant(restaurantId: string, asOf: Date = new Date()): Promise<CommissionRunRecord[]> {
    const plan = await this.billingPlanService.getForRestaurant(restaurantId);
    const created: CommissionRunRecord[] = [];

    for (;;) {
      const rows = await withTenant(this.db, { restaurantId }, (tx) => this.advanceOnePeriod(tx, restaurantId, plan, asOf));
      if (rows === null) break;
      created.push(...rows);
    }

    return created;
  }

  /** Returns null (and writes nothing) once the next pending period hasn't
   * fully elapsed yet — the loop's stopping condition. */
  private async advanceOnePeriod(tx: Database, restaurantId: string, plan: BillingPlanRecord, asOf: Date): Promise<CommissionRunRecord[] | null> {
    const period = await this.nextPendingPeriod(tx, restaurantId, plan.billingCycle);
    if (period.end > asOf) return null;
    return this.processPeriod(tx, restaurantId, plan, period);
  }

  private async nextPendingPeriod(tx: Database, restaurantId: string, cycle: BillingPlanRecord["billingCycle"]): Promise<BillingPeriod> {
    const cursorRows = await tx
      .select({ lastProcessedPeriodEnd: schema.commissionRunCursors.lastProcessedPeriodEnd })
      .from(schema.commissionRunCursors)
      .where(eq(schema.commissionRunCursors.restaurantId, restaurantId));
    if (cursorRows[0]) return billingPeriodContaining(cycle, cursorRows[0].lastProcessedPeriodEnd);

    const restaurantRows = await tx.select({ createdAt: schema.restaurants.createdAt }).from(schema.restaurants).where(eq(schema.restaurants.id, restaurantId));
    const restaurant = restaurantRows[0];
    if (!restaurant) throw new Error(`nextPendingPeriod: restaurant ${restaurantId} not found`);
    return billingPeriodContaining(cycle, restaurant.createdAt);
  }

  /**
   * One period, fully settled: a commission_runs row per currency with
   * real activity (plus the hybrid fixed fee's own currency even with
   * zero commission that period), then the cursor moves past it — all in
   * the caller's single transaction, so a crash between the two never
   * happens.
   *
   * P3-42: the per-currency commission_runs insert and its matching
   * settlement_statements insert are each one bulk statement covering
   * every currency this period touched, not one round trip per currency —
   * in practice a restaurant has exactly one currency almost always, so
   * this mostly collapses what used to be 2-4 inserts into 2, but the
   * shape is correct regardless of how many currencies a period actually
   * has. Audit logging stays one row per currency: each row is its own
   * distinct financial fact worth its own entry, and the row count here
   * is never large enough for that to matter.
   */
  private async processPeriod(tx: Database, restaurantId: string, plan: BillingPlanRecord, period: BillingPeriod): Promise<CommissionRunRecord[]> {
    const entryRows = await tx
      .select({ currency: schema.commissionEntries.currency, totalMinor: sql<string>`sum(${schema.commissionEntries.amountMinor})` })
      .from(schema.commissionEntries)
      .where(
        and(
          eq(schema.commissionEntries.restaurantId, restaurantId),
          gte(schema.commissionEntries.createdAt, period.start),
          lt(schema.commissionEntries.createdAt, period.end),
        ),
      )
      .groupBy(schema.commissionEntries.currency);

    const byCurrency = new Map<string, bigint>(entryRows.map((row) => [row.currency, BigInt(row.totalMinor)]));
    if (plan.planType === "hybrid" && plan.fixedFeeCurrency && !byCurrency.has(plan.fixedFeeCurrency)) {
      byCurrency.set(plan.fixedFeeCurrency, 0n);
    }

    if (byCurrency.size === 0) {
      await this.advanceCursor(tx, restaurantId, period.end);
      return [];
    }

    const runValues = [...byCurrency].map(([currency, commissionAmountMinor]) => {
      const fixedFeeAmountMinor = plan.planType === "hybrid" && currency === plan.fixedFeeCurrency ? plan.fixedFeeMinor ?? 0n : 0n;
      return {
        restaurantId,
        periodStart: period.start,
        periodEnd: period.end,
        planType: plan.planType,
        billingCycle: plan.billingCycle,
        commissionAmountMinor,
        fixedFeeAmountMinor,
        totalAmountMinor: commissionAmountMinor + fixedFeeAmountMinor,
        currency,
      };
    });

    const created = await tx.insert(schema.commissionRuns).values(runValues).onConflictDoNothing().returning();

    if (created.length > 0) {
      await this.settlementStatementsService.createManyForRunsInTx(
        tx,
        created.map((run) => ({
          restaurantId,
          commissionRunId: run.id,
          periodStart: run.periodStart,
          periodEnd: run.periodEnd,
          totalAmountMinor: run.totalAmountMinor,
          currency: run.currency,
        })),
      );

      for (const run of created) {
        await this.auditLogService.record(
          {
            restaurantId,
            actorUserId: null,
            action: "commission_run.created",
            targetType: "commission_run",
            targetId: run.id,
            metadata: {
              periodStart: period.start.toISOString(),
              periodEnd: period.end.toISOString(),
              currency: run.currency,
              commissionAmountMinor: run.commissionAmountMinor.toString(),
              fixedFeeAmountMinor: run.fixedFeeAmountMinor.toString(),
              totalAmountMinor: run.totalAmountMinor.toString(),
            },
          },
          tx,
        );
      }
    }

    await this.advanceCursor(tx, restaurantId, period.end);
    return created;
  }

  private async advanceCursor(tx: Database, restaurantId: string, periodEnd: Date): Promise<void> {
    await tx
      .insert(schema.commissionRunCursors)
      .values({ restaurantId, lastProcessedPeriodEnd: periodEnd })
      .onConflictDoUpdate({ target: schema.commissionRunCursors.restaurantId, set: { lastProcessedPeriodEnd: periodEnd, updatedAt: new Date() } });
  }

  private async listActiveRestaurantIds(): Promise<string[]> {
    return withTenant(this.db, { restaurantId: null, isSuperAdmin: true }, async (tx) => {
      const rows = await tx.select({ id: schema.restaurants.id }).from(schema.restaurants).where(eq(schema.restaurants.status, "active"));
      return rows.map((row) => row.id);
    });
  }
}
