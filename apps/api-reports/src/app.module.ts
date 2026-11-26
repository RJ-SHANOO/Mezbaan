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
  SalesReportsController,
  SalesReportsService,
  ServiceChargeSettingsService,
  TaxCalculationService,
  TaxRulesService,
  TaxSettingsService,
} from "@mezbaan/nest-core";

const DEFAULT_APP_DATABASE_URL = "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5432/mezbaan";

/** P2-40/P2-26: api-reports' first real features — basic pilot reports and
 * the reconciliation review queue. A dedicated, separately deployable
 * process (rule: "api-reports fails → selling and stock continue; reports
 * are delayed"), so this is the only place SalesReportsService/
 * ReconciliationService get wired up; nothing in api-pos/api-admin needs
 * them. ReconciliationService needs the same tax-resolution chain
 * (TaxRulesService/TaxSettingsService/ServiceChargeSettingsService →
 * TaxCalculationService) OrdersModule/CatalogModule already provide, since
 * it independently recomputes a tax preview, not just reads stored rows. */
@Module({
  imports: [DbModule.forRoot({ connectionString: process.env.APP_DATABASE_URL ?? DEFAULT_APP_DATABASE_URL })],
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
  ],
})
export class AppModule {}
