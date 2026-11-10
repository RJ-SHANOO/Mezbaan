import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { OrdersController } from "./orders.controller.js";
import { OrdersService } from "./orders.service.js";

/** P2-09: order headers for dine-in, takeaway and delivery. Requires
 * DbModule.forRoot(...) to already be imported, same as the other feature
 * modules. */
@Module({})
export class OrdersModule {
  static forRoot(): DynamicModule {
    return {
      module: OrdersModule,
      controllers: [OrdersController],
      providers: [OrdersService, AuditLogService],
      exports: [OrdersService],
    };
  }
}
