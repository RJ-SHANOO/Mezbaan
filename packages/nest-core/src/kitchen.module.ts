import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { KitchenRoutingRulesController } from "./kitchen-routing-rules.controller.js";
import { KitchenRoutingRulesService } from "./kitchen-routing-rules.service.js";
import { KitchenStationsController } from "./kitchen-stations.controller.js";
import { KitchenStationsService } from "./kitchen-stations.service.js";

/** P3-01: kitchen stations and their routing rules — its own module, same
 * split from CatalogModule as TablesModule (physical/operational kitchen
 * setup, not menu/pricing content). Requires DbModule.forRoot(...) to
 * already be imported, same as the other feature modules. */
@Module({})
export class KitchenModule {
  static forRoot(): DynamicModule {
    return {
      module: KitchenModule,
      controllers: [KitchenStationsController, KitchenRoutingRulesController],
      providers: [KitchenStationsService, KitchenRoutingRulesService, AuditLogService],
      exports: [KitchenStationsService, KitchenRoutingRulesService],
    };
  }
}
