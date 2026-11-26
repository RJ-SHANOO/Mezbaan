import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { BillingPlanController } from "./billing-plan.controller.js";
import { BillingPlanService } from "./billing-plan.service.js";

@Module({})
export class BillingPlanModule {
  /** Requires DbModule.forRoot(...) to already be imported, same as the other
   * feature modules. */
  static forRoot(): DynamicModule {
    return {
      module: BillingPlanModule,
      controllers: [BillingPlanController],
      providers: [BillingPlanService, AuditLogService],
      exports: [BillingPlanService],
    };
  }
}
