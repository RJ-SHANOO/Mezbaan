import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { DeliveryDetailsController } from "./delivery-details.controller.js";
import { DeliveryDetailsService } from "./delivery-details.service.js";
import { DeliveryRidersController } from "./delivery-riders.controller.js";
import { DeliveryRidersService } from "./delivery-riders.service.js";
import { InvoicesController } from "./invoices.controller.js";
import { InvoicesService } from "./invoices.service.js";
import { OrderItemsController } from "./order-items.controller.js";
import { OrderItemsService } from "./order-items.service.js";
import { OrdersController, TableTabController } from "./orders.controller.js";
import { OrdersService } from "./orders.service.js";
import { PriceResolutionService } from "./price-resolution.service.js";
import { ServiceChargeSettingsService } from "./service-charge-settings.service.js";
import { TaxCalculationService } from "./tax-calculation.service.js";
import { TaxRulesService } from "./tax-rules.service.js";
import { TaxSettingsService } from "./tax-settings.service.js";

/** P2-09: order headers for dine-in, takeaway and delivery. P2-10 (customer/
 * address capture, rider assignment, delivery status), P2-12 (the cart) and
 * P2-18 (invoice generation) extend the same module since all are direct
 * extensions of the order concept, not separate feature areas.
 * PriceResolutionService and the tax-rules/tax-settings/service-charge-settings
 * services are here too (same reason SyncModule needed PriceResolutionService for P2-11's
 * snapshot) — these are stateless, DB-only services also provided by
 * CatalogModule for api-admin's full catalog CRUD, but OrdersModule provides
 * its own copies directly rather than importing CatalogModule wholesale,
 * which would also pull every admin catalog-management controller into
 * api-pos ("the POS and sync API," not admin catalog management — section 4).
 * Requires DbModule.forRoot(...) to already be imported, same as the other
 * feature modules. */
@Module({})
export class OrdersModule {
  static forRoot(): DynamicModule {
    return {
      module: OrdersModule,
      controllers: [
        OrdersController,
        TableTabController,
        DeliveryRidersController,
        DeliveryDetailsController,
        OrderItemsController,
        InvoicesController,
      ],
      providers: [
        OrdersService,
        DeliveryRidersService,
        DeliveryDetailsService,
        OrderItemsService,
        InvoicesService,
        PriceResolutionService,
        TaxRulesService,
        TaxSettingsService,
        ServiceChargeSettingsService,
        TaxCalculationService,
        AuditLogService,
      ],
      exports: [OrdersService, DeliveryRidersService, DeliveryDetailsService, OrderItemsService, InvoicesService],
    };
  }
}
