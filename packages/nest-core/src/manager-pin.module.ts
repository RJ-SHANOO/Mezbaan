import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { ManagerPinController } from "./manager-pin.controller.js";
import { MANAGER_PIN_OPTIONS, ManagerPinService, type ManagerPinServiceOptions } from "./manager-pin.service.js";
import { PermissionsService } from "./permissions.service.js";

@Module({})
export class ManagerPinModule {
  /** Requires DbModule.forRoot(...) to already be imported, same as AuthModule. */
  static forRoot(options: ManagerPinServiceOptions = {}): DynamicModule {
    return {
      module: ManagerPinModule,
      controllers: [ManagerPinController],
      providers: [ManagerPinService, PermissionsService, AuditLogService, { provide: MANAGER_PIN_OPTIONS, useValue: options }],
      exports: [ManagerPinService],
    };
  }
}
