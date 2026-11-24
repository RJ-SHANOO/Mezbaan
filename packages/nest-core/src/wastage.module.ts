import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { MANAGER_PIN_OPTIONS, ManagerPinService } from "./manager-pin.service.js";
import { NegativeStockFlagsService } from "./negative-stock-flags.service.js";
import { PermissionsService } from "./permissions.service.js";
import { StockLedgerService } from "./stock-ledger.service.js";
import { StockLevelsService } from "./stock-levels.service.js";
import { WastageEntriesController, WastageLimitSettingsController, WastageReasonCodesController } from "./wastage.controller.js";
import { WastageService } from "./wastage.service.js";

/** P3-28: ad-hoc wastage entries with reason codes and approval limits —
 * its own module, same split as InventoryModule's other sibling modules,
 * providing its own copies of ManagerPinService and StockLedgerService
 * (same "don't pull in a whole module for one shared service" reasoning
 * OrdersModule's own docs already give). Requires DbModule.forRoot(...)
 * to already be imported, same as the other feature modules. */
@Module({})
export class WastageModule {
  static forRoot(): DynamicModule {
    return {
      module: WastageModule,
      controllers: [WastageReasonCodesController, WastageLimitSettingsController, WastageEntriesController],
      providers: [
        WastageService,
        AuditLogService,
        PermissionsService,
        ManagerPinService,
        { provide: MANAGER_PIN_OPTIONS, useValue: {} },
        StockLevelsService,
        NegativeStockFlagsService,
        StockLedgerService,
      ],
      exports: [WastageService],
    };
  }
}
