import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { CategoriesController } from "./categories.controller.js";
import { CategoriesService } from "./categories.service.js";
import { ComboSlotItemsController } from "./combo-slot-items.controller.js";
import { ComboSlotItemsService } from "./combo-slot-items.service.js";
import { ComboSlotsController } from "./combo-slots.controller.js";
import { ComboSlotsService } from "./combo-slots.service.js";
import { CombosController } from "./combos.controller.js";
import { CombosService } from "./combos.service.js";
import { ModifierGroupsController } from "./modifier-groups.controller.js";
import { ModifierGroupsService } from "./modifier-groups.service.js";
import { ModifierOptionsController } from "./modifier-options.controller.js";
import { ModifierOptionsService } from "./modifier-options.service.js";
import { PriceListItemsController } from "./price-list-items.controller.js";
import { PriceListItemsService } from "./price-list-items.service.js";
import { PriceListsController } from "./price-lists.controller.js";
import { PriceListsService } from "./price-lists.service.js";
import { PriceResolutionService } from "./price-resolution.service.js";
import { ProductVariantsController } from "./product-variants.controller.js";
import { ProductVariantsService } from "./product-variants.service.js";
import { ProductsController } from "./products.controller.js";
import { ProductsService } from "./products.service.js";

@Module({})
export class CatalogModule {
  /** Requires DbModule.forRoot(...) to already be imported, same as the other
   * feature modules. Categories, products, variants, modifiers (P2-02),
   * combos (P2-03) and price lists (P2-04) all share one module — all
   * catalog management, all gated by the same menu.manage permission. */
  static forRoot(): DynamicModule {
    return {
      module: CatalogModule,
      controllers: [
        CategoriesController,
        ProductsController,
        ProductVariantsController,
        ModifierGroupsController,
        ModifierOptionsController,
        CombosController,
        ComboSlotsController,
        ComboSlotItemsController,
        PriceListsController,
        PriceListItemsController,
      ],
      providers: [
        CategoriesService,
        ProductsService,
        ProductVariantsService,
        ModifierGroupsService,
        ModifierOptionsService,
        CombosService,
        ComboSlotsService,
        ComboSlotItemsService,
        PriceListsService,
        PriceListItemsService,
        PriceResolutionService,
        AuditLogService,
      ],
      exports: [
        CategoriesService,
        ProductsService,
        ProductVariantsService,
        ModifierGroupsService,
        ModifierOptionsService,
        CombosService,
        ComboSlotsService,
        ComboSlotItemsService,
        PriceListsService,
        PriceListItemsService,
        PriceResolutionService,
      ],
    };
  }
}
