import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { DiningTablesController } from "./dining-tables.controller.js";
import { DiningTablesService } from "./dining-tables.service.js";
import { FloorsController } from "./floors.controller.js";
import { FloorsService } from "./floors.service.js";

/** P2-07: floors and dining tables — their own module (not CatalogModule)
 * since this is physical branch layout, not menu/pricing content. Requires
 * DbModule.forRoot(...) to already be imported, same as the other feature
 * modules. */
@Module({})
export class TablesModule {
  static forRoot(): DynamicModule {
    return {
      module: TablesModule,
      controllers: [FloorsController, DiningTablesController],
      providers: [FloorsService, DiningTablesService, AuditLogService],
      exports: [FloorsService, DiningTablesService],
    };
  }
}
