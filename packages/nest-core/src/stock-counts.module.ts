import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { MANAGER_PIN_OPTIONS, ManagerPinService } from "./manager-pin.service.js";
import { NegativeStockFlagsService } from "./negative-stock-flags.service.js";
import { PermissionsService } from "./permissions.service.js";
import { StockCountsController } from "./stock-counts.controller.js";
import { StockCountsService } from "./stock-counts.service.js";
import { StockLedgerService } from "./stock-ledger.service.js";
import { StockLevelsService } from "./stock-levels.service.js";

/** P3-26/P3-27: full and cycle stock counts with blind entry, variance
 * review and approval — its own module, same split as InventoryModule's
 * other sibling modules, providing its own copies of ManagerPinService
 * and StockLedgerService (P3-27's approval step). Requires
 * DbModule.forRoot(...) to already be imported, same as the other
 * feature modules. */
@Module({})
export class StockCountsModule {
  static forRoot(): DynamicModule {
    return {
      module: StockCountsModule,
      controllers: [StockCountsController],
      providers: [
        StockCountsService,
        AuditLogService,
        PermissionsService,
        ManagerPinService,
        { provide: MANAGER_PIN_OPTIONS, useValue: {} },
        StockLevelsService,
        NegativeStockFlagsService,
        StockLedgerService,
      ],
      exports: [StockCountsService],
    };
  }
}
