import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { LowStockController, ParLevelsController } from "./par-levels.controller.js";
import { ParLevelsService } from "./par-levels.service.js";

/** P3-29: minimum/par stock levels and the low-stock check — its own
 * module, same split as InventoryModule's other sibling modules.
 * Requires DbModule.forRoot(...) to already be imported, same as the
 * other feature modules. */
@Module({})
export class ParLevelsModule {
  static forRoot(): DynamicModule {
    return {
      module: ParLevelsModule,
      controllers: [ParLevelsController, LowStockController],
      providers: [ParLevelsService, AuditLogService],
      exports: [ParLevelsService],
    };
  }
}
