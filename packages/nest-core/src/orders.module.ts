import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { DeliveryDetailsController } from "./delivery-details.controller.js";
import { DeliveryDetailsService } from "./delivery-details.service.js";
import { DeliveryRidersController } from "./delivery-riders.controller.js";
import { DeliveryRidersService } from "./delivery-riders.service.js";
import { OrderItemsController } from "./order-items.controller.js";
import { OrderItemsService } from "./order-items.service.js";
import { OrdersController } from "./orders.controller.js";
import { OrdersService } from "./orders.service.js";
import { PriceResolutionService } from "./price-resolution.service.js";

/** P2-09: order headers for dine-in, takeaway and delivery. P2-10 (customer/
 * address capture, rider assignment, delivery status) and P2-12 (the cart —
 * order items with quantities/modifiers/notes/seat-or-course) extend the
 * same module since both are direct extensions of the order concept, not
 * separate feature areas. PriceResolutionService is here too (same reason
 * SyncModule needed it for P2-11's snapshot) — OrderItemsService calls it
 * directly rather than duplicating P2-04's resolution logic. Requires
 * DbModule.forRoot(...) to already be imported, same as the other feature
 * modules. */
@Module({})
export class OrdersModule {
  static forRoot(): DynamicModule {
    return {
      module: OrdersModule,
      controllers: [OrdersController, DeliveryRidersController, DeliveryDetailsController, OrderItemsController],
      providers: [OrdersService, DeliveryRidersService, DeliveryDetailsService, OrderItemsService, PriceResolutionService, AuditLogService],
      exports: [OrdersService, DeliveryRidersService, DeliveryDetailsService, OrderItemsService],
    };
  }
}
