import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { DeviceAuthGuard } from "./device-auth.guard.js";
import { DeviceService } from "./device.service.js";
import { ReleasesController } from "./releases.controller.js";
import { ReleasesService } from "./releases.service.js";

@Module({})
export class ReleasesModule {
  /** Requires DbModule.forRoot(...) to already be imported, same as the other
   * feature modules. Mounted in api-pos only — see releases.controller.ts. */
  static forRoot(): DynamicModule {
    return {
      module: ReleasesModule,
      controllers: [ReleasesController],
      providers: [ReleasesService, DeviceService, AuditLogService, DeviceAuthGuard],
      exports: [ReleasesService],
    };
  }
}
