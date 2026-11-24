import { Module } from "@nestjs/common";
import {
  AuditLogService,
  DbModule,
  HealthController,
  MetricsController,
  NegativeStockFlagsService,
  OutboxModule,
  ReconciliationService,
  RecipesService,
  SalesStockDeductionService,
  ServiceChargeSettingsService,
  StockLedgerService,
  StockLevelsService,
  TaxCalculationService,
  TaxRulesService,
  TaxSettingsService,
} from "@mezbaan/nest-core";
import { ReconciliationHandlerProvider } from "./reconciliation-handler.provider.js";
import { SalesStockDeductionHandlerProvider } from "./sales-stock-deduction-handler.provider.js";

const DEFAULT_APP_DATABASE_URL = "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5432/mezbaan";

// Commission runs, settlements and notifications are added in later tasks.
// Outbox relaying (P1-30) is the first job this process actually runs — it's
// the only process that passes autoStart: true, since every api-* process only
// needs OutboxService to write rows, not to also poll and process them.
//
// P2-26 is the first real handler: ReconciliationHandlerProvider registers
// itself against "invoice.generated" in its own onModuleInit (see that
// file for why `handlers` below stays empty rather than listing it there
// directly). P3-17's SalesStockDeductionHandlerProvider registers against
// the separate "invoice.stock_deduct" event the same way. Every other
// event type still has no handler, which still goes through the normal
// retry/dead-letter path (rule 16) rather than being skipped.
@Module({
  imports: [
    DbModule.forRoot({ connectionString: process.env.APP_DATABASE_URL ?? DEFAULT_APP_DATABASE_URL }),
    OutboxModule.forRoot({ autoStart: true, handlers: {} }),
  ],
  controllers: [HealthController, MetricsController],
  providers: [
    AuditLogService,
    TaxRulesService,
    TaxSettingsService,
    ServiceChargeSettingsService,
    TaxCalculationService,
    ReconciliationService,
    ReconciliationHandlerProvider,
    RecipesService,
    StockLevelsService,
    NegativeStockFlagsService,
    StockLedgerService,
    SalesStockDeductionService,
    SalesStockDeductionHandlerProvider,
  ],
})
export class AppModule {}
