import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { DeliveryDetailsController } from "./delivery-details.controller.js";
import { DeliveryDetailsService } from "./delivery-details.service.js";
import { DeliveryRidersController } from "./delivery-riders.controller.js";
import { DeliveryRidersService } from "./delivery-riders.service.js";
import { OrdersController } from "./orders.controller.js";
import { OrdersService } from "./orders.service.js";

/** P2-09: order headers for dine-in, takeaway and delivery. P2-10 (customer/
 * address capture, rider assignment, delivery status) extends the same
 * module since it's a direct extension of the order concept, not a separate
 * feature area. Requires DbModule.forRoot(...) to already be imported, same
 * as the other feature modules. */
@Module({})
export class OrdersModule {
  static forRoot(): DynamicModule {
    return {
      module: OrdersModule,
      controllers: [OrdersController, DeliveryRidersController, DeliveryDetailsController],
      providers: [OrdersService, DeliveryRidersService, DeliveryDetailsService, AuditLogService],
      exports: [OrdersService, DeliveryRidersService, DeliveryDetailsService],
    };
  }
}
