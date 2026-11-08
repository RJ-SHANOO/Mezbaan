import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { FeatureFlagsController } from "./feature-flags.controller.js";
import { FeatureFlagsService } from "./feature-flags.service.js";

@Module({})
export class FeatureFlagsModule {
  /** Requires DbModule.forRoot(...) to already be imported, same as the other
   * feature modules. */
  static forRoot(): DynamicModule {
    return {
      module: FeatureFlagsModule,
      controllers: [FeatureFlagsController],
      providers: [FeatureFlagsService, AuditLogService],
      exports: [FeatureFlagsService],
    };
  }
}
