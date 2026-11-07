import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { BranchesController } from "./branches.controller.js";
import { BranchesService } from "./branches.service.js";

@Module({})
export class BranchesModule {
  /** Requires DbModule.forRoot(...) to already be imported, same as the other
   * feature modules. */
  static forRoot(): DynamicModule {
    return {
      module: BranchesModule,
      controllers: [BranchesController],
      providers: [BranchesService, AuditLogService],
      exports: [BranchesService],
    };
  }
}
