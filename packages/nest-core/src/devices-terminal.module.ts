import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { DeviceAuthGuard } from "./device-auth.guard.js";
import { DeviceService } from "./device.service.js";
import { DevicesTerminalController } from "./devices-terminal.controller.js";

@Module({})
export class DevicesTerminalModule {
  /** Requires DbModule.forRoot(...) to already be imported, same as the other
   * feature modules. Mounted in api-pos only — see devices-terminal.controller.ts.
   * DeviceAuthGuard is listed as a provider (not just `@UseGuards`'d) so Nest's DI
   * container can inject DeviceService into it. */
  static forRoot(): DynamicModule {
    return {
      module: DevicesTerminalModule,
      controllers: [DevicesTerminalController],
      providers: [DeviceService, AuditLogService, DeviceAuthGuard],
      exports: [DeviceService],
    };
  }
}
