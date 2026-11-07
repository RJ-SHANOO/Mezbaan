import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { DeviceService } from "./device.service.js";
import { DevicesAdminController } from "./devices-admin.controller.js";

@Module({})
export class DevicesAdminModule {
  /** Requires DbModule.forRoot(...) to already be imported, same as the other
   * feature modules. Mounted in api-admin only — see devices-admin.controller.ts. */
  static forRoot(): DynamicModule {
    return {
      module: DevicesAdminModule,
      controllers: [DevicesAdminController],
      providers: [DeviceService, AuditLogService],
      exports: [DeviceService],
    };
  }
}
