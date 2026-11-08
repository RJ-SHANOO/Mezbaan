import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { DeviceAuthGuard } from "./device-auth.guard.js";
import { DeviceService } from "./device.service.js";
import { SyncController } from "./sync.controller.js";
import { SyncService } from "./sync.service.js";
import { SyncSnapshotController } from "./sync-snapshot.controller.js";
import { SyncSnapshotService } from "./sync-snapshot.service.js";

@Module({})
export class SyncModule {
  /** Requires DbModule.forRoot(...) to already be imported, same as the other
   * feature modules. DeviceAuthGuard needs DeviceService injected into it (same
   * reasoning as DevicesTerminalModule), so both are listed as providers here too,
   * not just imported — @UseGuards(DeviceAuthGuard) alone doesn't register it with
   * this module's DI container. Upstream (P1-26, SyncController) and downstream
   * (P1-27, SyncSnapshotController) sync share this module and its device-auth
   * providers rather than each duplicating them. */
  static forRoot(): DynamicModule {
    return {
      module: SyncModule,
      controllers: [SyncController, SyncSnapshotController],
      providers: [SyncService, SyncSnapshotService, DeviceService, AuditLogService, DeviceAuthGuard],
      exports: [SyncService, SyncSnapshotService],
    };
  }
}
