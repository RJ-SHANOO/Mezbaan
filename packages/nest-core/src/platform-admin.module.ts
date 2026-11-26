import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { BillingPlanService } from "./billing-plan.service.js";
import { DeviceService } from "./device.service.js";
import { PlatformRevenueController } from "./platform-revenue.controller.js";
import { PlatformRevenueService } from "./platform-revenue.service.js";
import { RestaurantsAdminController } from "./restaurants-admin.controller.js";
import { RestaurantsAdminService } from "./restaurants-admin.service.js";
import { SettlementStatementsService } from "./settlement-statements.service.js";

/**
 * P3-39: Super Admin — restaurant list, status, plans (via
 * BillingPlanService, already built in P3-36), devices (via
 * DeviceService.listAsSuperAdmin), platform revenue and the restaurant
 * detail "support tool" lookup, all bundled under one module the same
 * way this whole task bundles them under one checklist item. Provides its
 * own copies of BillingPlanService/DeviceService/SettlementStatementsService
 * (same "provide its own copy" convention as OrdersModule/CatalogModule)
 * rather than importing BillingPlanModule/SettlementStatementsModule
 * wholesale, which would also pull in their own restaurant-facing
 * controllers that this module has no business mounting again.
 */
@Module({})
export class PlatformAdminModule {
  /** Requires DbModule.forRoot(...) to already be imported, same as the
   * other feature modules. */
  static forRoot(): DynamicModule {
    return {
      module: PlatformAdminModule,
      controllers: [RestaurantsAdminController, PlatformRevenueController],
      providers: [AuditLogService, BillingPlanService, DeviceService, SettlementStatementsService, RestaurantsAdminService, PlatformRevenueService],
      exports: [RestaurantsAdminService, PlatformRevenueService],
    };
  }
}
