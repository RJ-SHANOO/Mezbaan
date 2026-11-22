import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { InventoryCategoriesController } from "./inventory-categories.controller.js";
import { InventoryCategoriesService } from "./inventory-categories.service.js";
import { InventoryItemUnitConversionsController } from "./inventory-item-unit-conversions.controller.js";
import { InventoryItemUnitConversionsService } from "./inventory-item-unit-conversions.service.js";
import { InventoryItemsController } from "./inventory-items.controller.js";
import { InventoryItemsService } from "./inventory-items.service.js";
import { NegativeStockFlagsController } from "./negative-stock-flags.controller.js";
import { NegativeStockFlagsService } from "./negative-stock-flags.service.js";
import { StockLedgerController } from "./stock-ledger.controller.js";
import { StockLedgerService } from "./stock-ledger.service.js";
import { StockLevelsController } from "./stock-levels.controller.js";
import { StockLevelsService } from "./stock-levels.service.js";
import { StorageLocationsController } from "./storage-locations.controller.js";
import { StorageLocationsService } from "./storage-locations.service.js";
import { UnitsController } from "./units.controller.js";
import { UnitsService } from "./units.service.js";

/** P3-07 through P3-12: inventory categories, items, storage locations,
 * units, per-item unit conversions, the stock ledger, its derived stock-
 * levels cache (with weighted-average costing) and negative-stock review
 * flags — its own module, same split from CatalogModule as TablesModule/
 * KitchenModule (physical/operational stock setup, not menu/pricing
 * content). Requires DbModule.forRoot(...) to already be imported, same
 * as the other feature modules. */
@Module({})
export class InventoryModule {
  static forRoot(): DynamicModule {
    return {
      module: InventoryModule,
      controllers: [
        InventoryCategoriesController,
        StorageLocationsController,
        UnitsController,
        InventoryItemsController,
        InventoryItemUnitConversionsController,
        StockLedgerController,
        StockLevelsController,
        NegativeStockFlagsController,
      ],
      providers: [
        InventoryCategoriesService,
        StorageLocationsService,
        UnitsService,
        InventoryItemsService,
        InventoryItemUnitConversionsService,
        StockLevelsService,
        NegativeStockFlagsService,
        StockLedgerService,
        AuditLogService,
      ],
      exports: [
        InventoryCategoriesService,
        StorageLocationsService,
        UnitsService,
        InventoryItemsService,
        InventoryItemUnitConversionsService,
        StockLedgerService,
        StockLevelsService,
        NegativeStockFlagsService,
      ],
    };
  }
}
