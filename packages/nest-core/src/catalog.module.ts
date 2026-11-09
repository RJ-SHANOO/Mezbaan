import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { CategoriesController } from "./categories.controller.js";
import { CategoriesService } from "./categories.service.js";
import { ProductsController } from "./products.controller.js";
import { ProductsService } from "./products.service.js";

@Module({})
export class CatalogModule {
  /** Requires DbModule.forRoot(...) to already be imported, same as the other
   * feature modules. Categories and products share one module (P2-01) since
   * products always reference a category and the two are managed together. */
  static forRoot(): DynamicModule {
    return {
      module: CatalogModule,
      controllers: [CategoriesController, ProductsController],
      providers: [CategoriesService, ProductsService, AuditLogService],
      exports: [CategoriesService, ProductsService],
    };
  }
}
