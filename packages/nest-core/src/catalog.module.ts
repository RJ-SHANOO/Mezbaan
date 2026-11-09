import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { CategoriesController } from "./categories.controller.js";
import { CategoriesService } from "./categories.service.js";
import { ModifierGroupsController } from "./modifier-groups.controller.js";
import { ModifierGroupsService } from "./modifier-groups.service.js";
import { ModifierOptionsController } from "./modifier-options.controller.js";
import { ModifierOptionsService } from "./modifier-options.service.js";
import { ProductVariantsController } from "./product-variants.controller.js";
import { ProductVariantsService } from "./product-variants.service.js";
import { ProductsController } from "./products.controller.js";
import { ProductsService } from "./products.service.js";

@Module({})
export class CatalogModule {
  /** Requires DbModule.forRoot(...) to already be imported, same as the other
   * feature modules. Categories, products, variants and modifiers (P2-01/P2-02)
   * all share one module since they're all catalog management, managed
   * together by the same menu.manage permission. */
  static forRoot(): DynamicModule {
    return {
      module: CatalogModule,
      controllers: [CategoriesController, ProductsController, ProductVariantsController, ModifierGroupsController, ModifierOptionsController],
      providers: [CategoriesService, ProductsService, ProductVariantsService, ModifierGroupsService, ModifierOptionsService, AuditLogService],
      exports: [CategoriesService, ProductsService, ProductVariantsService, ModifierGroupsService, ModifierOptionsService],
    };
  }
}
