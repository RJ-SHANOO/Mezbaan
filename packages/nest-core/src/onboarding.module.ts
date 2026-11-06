import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { AuthModule } from "./auth.module.js";
import type { AuthServiceOptions } from "./auth.service.js";
import { ONBOARDING_OPTIONS, OnboardingService, type OnboardingServiceOptions } from "./onboarding.service.js";
import { OnboardingController } from "./onboarding.controller.js";

export type OnboardingModuleOptions = OnboardingServiceOptions & AuthServiceOptions;

@Module({})
export class OnboardingModule {
  /** Requires DbModule.forRoot(...) to already be imported, same as AuthModule. Takes
   * the same jwt options as the app's own AuthModule.forRoot — signup logs the new
   * owner in immediately (see OnboardingController), so it needs an AuthService
   * configured identically, even though that means a second, independent instance
   * rather than reusing the app-level one (both are stateless, so this is harmless —
   * same pattern as PermissionsService being instantiated per-module elsewhere). */
  static forRoot(options: OnboardingModuleOptions): DynamicModule {
    const { defaultCommissionRateBasisPoints, ...authOptions } = options;
    return {
      module: OnboardingModule,
      imports: [AuthModule.forRoot(authOptions)],
      controllers: [OnboardingController],
      providers: [OnboardingService, AuditLogService, { provide: ONBOARDING_OPTIONS, useValue: { defaultCommissionRateBasisPoints } }],
      exports: [OnboardingService],
    };
  }
}
