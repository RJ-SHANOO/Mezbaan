import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { GoodsReceivedNotesController, GoodsRejectionReasonCodesController, PurchaseOrderGoodsReceivedNotesController } from "./goods-received-notes.controller.js";
import { GoodsReceivedNotesService } from "./goods-received-notes.service.js";
import { NegativeStockFlagsService } from "./negative-stock-flags.service.js";
import { StockLedgerService } from "./stock-ledger.service.js";
import { StockLevelsService } from "./stock-levels.service.js";

/** P3-22: goods received notes — its own module, same "Purchasing and
 * suppliers" split as SuppliersModule/PurchaseOrdersModule, providing its
 * own copies of StockLedgerService and its own dependencies (same "don't
 * pull in a whole module for one shared service" reasoning OrdersModule's
 * own docs already give). Requires DbModule.forRoot(...) and
 * PurchaseOrdersModule.forRoot() to already be imported (the latter not
 * for DI — this module reads purchase_orders/purchase_order_items
 * directly via the shared `schema` object, same as every other module
 * that reaches across a table boundary). */
@Module({})
export class GoodsReceivedNotesModule {
  static forRoot(): DynamicModule {
    return {
      module: GoodsReceivedNotesModule,
      controllers: [GoodsReceivedNotesController, GoodsRejectionReasonCodesController, PurchaseOrderGoodsReceivedNotesController],
      providers: [GoodsReceivedNotesService, AuditLogService, StockLevelsService, NegativeStockFlagsService, StockLedgerService],
      exports: [GoodsReceivedNotesService],
    };
  }
}
