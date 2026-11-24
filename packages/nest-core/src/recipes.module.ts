import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { RecipesController } from "./recipes.controller.js";
import { RecipesService } from "./recipes.service.js";

/** P3-13: recipes bridge the menu (products/variants) and inventory
 * (items/units) domains, so neither CatalogModule nor InventoryModule
 * owns them outright — its own module, same split reasoning as
 * TablesModule/KitchenModule. Requires DbModule.forRoot(...) to already
 * be imported, same as the other feature modules. */
@Module({})
export class RecipesModule {
  static forRoot(): DynamicModule {
    return {
      module: RecipesModule,
      controllers: [RecipesController],
      providers: [RecipesService, AuditLogService],
      exports: [RecipesService],
    };
  }
}
