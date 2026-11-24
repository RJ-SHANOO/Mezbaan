import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { MANAGER_PIN_OPTIONS, ManagerPinService } from "./manager-pin.service.js";
import { PermissionsService } from "./permissions.service.js";
import { PurchaseOrdersController } from "./purchase-orders.controller.js";
import { PurchaseOrdersService } from "./purchase-orders.service.js";

/** P3-21: purchase orders — its own module, same "Purchasing and
 * suppliers" split as SuppliersModule, providing its own copy of
 * ManagerPinService (P2-22/23/24's established pattern) rather than
 * importing a whole other module for it. Requires DbModule.forRoot(...)
 * to already be imported, same as the other feature modules. */
@Module({})
export class PurchaseOrdersModule {
  static forRoot(): DynamicModule {
    return {
      module: PurchaseOrdersModule,
      controllers: [PurchaseOrdersController],
      providers: [PurchaseOrdersService, AuditLogService, PermissionsService, ManagerPinService, { provide: MANAGER_PIN_OPTIONS, useValue: {} }],
      exports: [PurchaseOrdersService],
    };
  }
}
