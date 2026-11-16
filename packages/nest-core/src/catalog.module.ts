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
import { CashMovementReasonCodesController } from "./cash-movements.controller.js";
import { CashMovementsService } from "./cash-movements.service.js";
import { CreditCustomersController } from "./credit-customers.controller.js";
import { ReceiptSettingsController } from "./receipt-settings.controller.js";
import { ReceiptSettingsService } from "./receipt-settings.service.js";
import { CreditCustomersService } from "./credit-customers.service.js";
import { DiscountLimitsController, DiscountReasonCodesController } from "./discounts.controller.js";
import { DiscountsService } from "./discounts.service.js";
import { MANAGER_PIN_OPTIONS, ManagerPinService } from "./manager-pin.service.js";
import { ModifierGroupsController } from "./modifier-groups.controller.js";
import { ModifierGroupsService } from "./modifier-groups.service.js";
import { ModifierOptionsController } from "./modifier-options.controller.js";
import { ModifierOptionsService } from "./modifier-options.service.js";
import { PaymentMethodSettingsController } from "./payment-method-settings.controller.js";
import { PaymentMethodSettingsService } from "./payment-method-settings.service.js";
import { PermissionsService } from "./permissions.service.js";
import { PriceListItemsController } from "./price-list-items.controller.js";
import { PriceListItemsService } from "./price-list-items.service.js";
import { PriceListsController } from "./price-lists.controller.js";
import { MenuSnapshotCacheService } from "./menu-snapshot-cache.service.js";
import { PriceListsService } from "./price-lists.service.js";
import { PriceResolutionService } from "./price-resolution.service.js";
import { ProductVariantsController } from "./product-variants.controller.js";
import { ProductVariantsService } from "./product-variants.service.js";
import { ProductsController } from "./products.controller.js";
import { ProductsService } from "./products.service.js";
import { ProductStockStatusController } from "./product-stock-status.controller.js";
import { ProductStockStatusService } from "./product-stock-status.service.js";
import { ServiceChargeSettingsController } from "./service-charge-settings.controller.js";
import { ServiceChargeSettingsService } from "./service-charge-settings.service.js";
import { TaxCalculationController } from "./tax-calculation.controller.js";
import { TaxCalculationService } from "./tax-calculation.service.js";
import { TaxRulesController } from "./tax-rules.controller.js";
import { TaxRulesService } from "./tax-rules.service.js";
import { RefundReasonCodesController } from "./refunds.controller.js";
import { RefundsService } from "./refunds.service.js";
import { TaxSettingsController } from "./tax-settings.controller.js";
import { TaxSettingsService } from "./tax-settings.service.js";
import { VoidReasonCodesController } from "./voids.controller.js";
import { VoidsService } from "./voids.service.js";

@Module({})
export class CatalogModule {
  /** Requires DbModule.forRoot(...) to already be imported, same as the other
   * feature modules. Categories, products, variants, modifiers (P2-02),
   * combos (P2-03), price lists (P2-04), tax/service-charge rules (P2-05) and
   * out-of-stock marking (P2-06) all share one module — all catalog/pricing/
   * stock-status management, gated by menu.manage or (for the more
   * operational out-of-stock flag) pos.mark_out_of_stock. */
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
        TaxRulesController,
        TaxSettingsController,
        ServiceChargeSettingsController,
        TaxCalculationController,
        ProductStockStatusController,
        PaymentMethodSettingsController,
        DiscountReasonCodesController,
        DiscountLimitsController,
        VoidReasonCodesController,
        RefundReasonCodesController,
        CreditCustomersController,
        CashMovementReasonCodesController,
        ReceiptSettingsController,
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
        MenuSnapshotCacheService,
        TaxRulesService,
        TaxSettingsService,
        ServiceChargeSettingsService,
        TaxCalculationService,
        ProductStockStatusService,
        PaymentMethodSettingsService,
        DiscountsService,
        VoidsService,
        RefundsService,
        CreditCustomersService,
        CashMovementsService,
        ReceiptSettingsService,
        ManagerPinService,
        PermissionsService,
        { provide: MANAGER_PIN_OPTIONS, useValue: {} },
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
        TaxRulesService,
        TaxSettingsService,
        ServiceChargeSettingsService,
        TaxCalculationService,
        ProductStockStatusService,
        PaymentMethodSettingsService,
        DiscountsService,
        VoidsService,
        RefundsService,
        CreditCustomersService,
        CashMovementsService,
        ReceiptSettingsService,
      ],
    };
  }
}
