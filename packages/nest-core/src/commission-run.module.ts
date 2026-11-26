import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { BillingPlanService } from "./billing-plan.service.js";
import { CommissionRunService } from "./commission-run.service.js";
import { COMMISSION_RUN_SCHEDULER_OPTIONS, CommissionRunScheduler, type CommissionRunSchedulerOptions } from "./commission-run-scheduler.service.js";
import { SettlementStatementsService } from "./settlement-statements.service.js";

@Module({})
export class CommissionRunModule {
  /** Requires DbModule.forRoot(...) to already be imported, same as the
   * other feature modules. Every process can safely import this with no
   * options (autoStart defaults to false) — only apps/worker should pass
   * `autoStart: true`, the same split OutboxModule uses. */
  static forRoot(options: CommissionRunSchedulerOptions = {}): DynamicModule {
    return {
      module: CommissionRunModule,
      providers: [
        AuditLogService,
        BillingPlanService,
        SettlementStatementsService,
        CommissionRunService,
        CommissionRunScheduler,
        { provide: COMMISSION_RUN_SCHEDULER_OPTIONS, useValue: options },
      ],
      exports: [CommissionRunService, SettlementStatementsService],
    };
  }
}
