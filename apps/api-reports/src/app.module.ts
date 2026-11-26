import { Module } from "@nestjs/common";
import {
  AuditLogService,
  DbModule,
  HealthController,
  InventoryReportsController,
  InventoryReportsService,
  KitchenPrepTimeReportsController,
  KitchenPrepTimeReportsService,
  MetricsController,
  ReconciliationFlagsController,
  ReconciliationService,
  ReportsQueueModule,
  SalesReportsController,
  SalesReportsService,
  ServiceChargeSettingsService,
  TaxCalculationService,
  TaxRulesService,
  TaxSettingsService,
} from "@mezbaan/nest-core";
import { ReportJobHandlersProvider } from "./report-job-handlers.provider.js";

const DEFAULT_APP_DATABASE_URL = "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5432/mezbaan";
const DEFAULT_REDIS_URL = "redis://localhost:6379";
const DEFAULT_REPORTS_QUEUE_CONCURRENCY = 2;

/** P2-40/P2-26: api-reports' first real features — basic pilot reports and
 * the reconciliation review queue. A dedicated, separately deployable
 * process (rule: "api-reports fails → selling and stock continue; reports
 * are delayed"), so this is the only place SalesReportsService/
 * ReconciliationService get wired up; nothing in api-pos/api-admin needs
 * them. ReconciliationService needs the same tax-resolution chain
 * (TaxRulesService/TaxSettingsService/ServiceChargeSettingsService →
 * TaxCalculationService) OrdersModule/CatalogModule already provide, since
 * it independently recomputes a tax preview, not just reads stored rows.
 *
 * P3-43: `autoStart: true` here is deliberate — api-reports is both the
 * only enqueuer of a report job (every report controller) and the only
 * process that should actually compute one (ReportJobHandlersProvider),
 * same "exactly one place runs the loop" split OutboxModule/
 * CommissionRunModule already use elsewhere, just within one process
 * instead of across two. SalesReportsService/InventoryReportsService/
 * KitchenPrepTimeReportsService stay in `providers` — they're no longer
 * called from a controller directly, but ReportJobHandlersProvider still
 * needs them injected. */
@Module({
  imports: [
    DbModule.forRoot({ connectionString: process.env.APP_DATABASE_URL ?? DEFAULT_APP_DATABASE_URL }),
    ReportsQueueModule.forRoot({
      redisUrl: process.env.REDIS_URL ?? DEFAULT_REDIS_URL,
      concurrency: process.env.REPORTS_QUEUE_CONCURRENCY ? Number(process.env.REPORTS_QUEUE_CONCURRENCY) : DEFAULT_REPORTS_QUEUE_CONCURRENCY,
      autoStart: true,
    }),
  ],
  controllers: [HealthController, MetricsController, SalesReportsController, ReconciliationFlagsController, KitchenPrepTimeReportsController, InventoryReportsController],
  providers: [
    SalesReportsService,
    AuditLogService,
    TaxRulesService,
    TaxSettingsService,
    ServiceChargeSettingsService,
    TaxCalculationService,
    ReconciliationService,
    KitchenPrepTimeReportsService,
    InventoryReportsService,
    ReportJobHandlersProvider,
  ],
})
export class AppModule {}
