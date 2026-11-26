import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { SettlementStatementsController } from "./settlement-statements.controller.js";
import { SettlementStatementsService } from "./settlement-statements.service.js";

@Module({})
export class SettlementStatementsModule {
  /** Requires DbModule.forRoot(...) to already be imported, same as the
   * other feature modules. */
  static forRoot(): DynamicModule {
    return {
      module: SettlementStatementsModule,
      controllers: [SettlementStatementsController],
      providers: [SettlementStatementsService, AuditLogService],
      exports: [SettlementStatementsService],
    };
  }
}
