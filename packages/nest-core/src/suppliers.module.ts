import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { SupplierItemPricesController } from "./supplier-item-prices.controller.js";
import { SupplierItemPricesService } from "./supplier-item-prices.service.js";
import { SupplierItemsController } from "./supplier-items.controller.js";
import { SupplierItemsService } from "./supplier-items.service.js";
import { SuppliersController } from "./suppliers.controller.js";
import { SuppliersService } from "./suppliers.service.js";

/** P3-20: supplier records, which items each one supplies, and append-
 * only price history — its own module, same "Purchasing and suppliers"
 * split from InventoryModule as RecipesModule/ProductionModule each got
 * their own. Requires DbModule.forRoot(...) to already be imported, same
 * as the other feature modules. */
@Module({})
export class SuppliersModule {
  static forRoot(): DynamicModule {
    return {
      module: SuppliersModule,
      controllers: [SuppliersController, SupplierItemsController, SupplierItemPricesController],
      providers: [SuppliersService, SupplierItemsService, SupplierItemPricesService, AuditLogService],
      exports: [SuppliersService, SupplierItemsService, SupplierItemPricesService],
    };
  }
}
