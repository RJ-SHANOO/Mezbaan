import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { ONBOARDING_OPTIONS, OnboardingService, type OnboardingServiceOptions } from "./onboarding.service.js";
import { OnboardingController } from "./onboarding.controller.js";

@Module({})
export class OnboardingModule {
  /** Requires DbModule.forRoot(...) and AuthModule.forRoot(...) to already be imported
   * somewhere in the app (for the DATABASE provider and AuthService respectively).
   * Doesn't import AuthModule itself: AuthModule.forRoot is global (see its own doc
   * comment for why), so OnboardingController's AuthService dependency resolves from
   * whichever single registration the app already has, with no second instance and
   * no risk of double-registering /auth/* routes. */
  static forRoot(options: OnboardingServiceOptions = {}): DynamicModule {
    return {
      module: OnboardingModule,
      controllers: [OnboardingController],
      providers: [OnboardingService, AuditLogService, { provide: ONBOARDING_OPTIONS, useValue: options }],
      exports: [OnboardingService],
    };
  }
}
