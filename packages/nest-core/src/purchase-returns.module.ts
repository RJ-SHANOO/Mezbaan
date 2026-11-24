import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { NegativeStockFlagsService } from "./negative-stock-flags.service.js";
import { PurchaseOrderPurchaseReturnsController, PurchaseReturnReasonCodesController, PurchaseReturnsController } from "./purchase-returns.controller.js";
import { PurchaseReturnsService } from "./purchase-returns.service.js";
import { StockLedgerService } from "./stock-ledger.service.js";
import { StockLevelsService } from "./stock-levels.service.js";

/** P3-24: purchase returns — its own module, same "Purchasing and
 * suppliers" split as every other module in this section, providing its
 * own copies of StockLedgerService and its own dependencies. Requires
 * DbModule.forRoot(...) to already be imported, same as the other
 * feature modules. */
@Module({})
export class PurchaseReturnsModule {
  static forRoot(): DynamicModule {
    return {
      module: PurchaseReturnsModule,
      controllers: [PurchaseReturnsController, PurchaseReturnReasonCodesController, PurchaseOrderPurchaseReturnsController],
      providers: [PurchaseReturnsService, AuditLogService, StockLevelsService, NegativeStockFlagsService, StockLedgerService],
      exports: [PurchaseReturnsService],
    };
  }
}
