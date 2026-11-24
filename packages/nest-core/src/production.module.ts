import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { NegativeStockFlagsService } from "./negative-stock-flags.service.js";
import { ProductionController } from "./production.controller.js";
import { ProductionService } from "./production.service.js";
import { RecipesService } from "./recipes.service.js";
import { StockLedgerService } from "./stock-ledger.service.js";
import { StockLevelsService } from "./stock-levels.service.js";

/** P3-16: production batches bridge recipes and the stock ledger, so
 * neither RecipesModule nor InventoryModule owns it outright — its own
 * module, same split reasoning as RecipesModule itself, providing its
 * own copies of the services it composes (StockLedgerService and its own
 * dependencies, RecipesService) rather than importing those modules
 * wholesale, same "don't pull in a whole module for one shared service"
 * reasoning OrdersModule's own docs already give. Requires
 * DbModule.forRoot(...) to already be imported, same as the other
 * feature modules. */
@Module({})
export class ProductionModule {
  static forRoot(): DynamicModule {
    return {
      module: ProductionModule,
      controllers: [ProductionController],
      providers: [ProductionService, RecipesService, StockLedgerService, StockLevelsService, NegativeStockFlagsService, AuditLogService],
      exports: [ProductionService],
    };
  }
}
