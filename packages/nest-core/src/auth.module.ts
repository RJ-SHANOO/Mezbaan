import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { AUTH_OPTIONS, AuthService, type AuthServiceOptions } from "./auth.service.js";
import { AuthController } from "./auth.controller.js";

@Module({})
export class AuthModule {
  /** Requires DbModule.forRoot(...) to already be imported (for the DATABASE provider)
   * — AuthService depends on it but this module doesn't re-provide it.
   *
   * Global, and meant to be called exactly once per app: a dynamic module with
   * `controllers` gets its routes mapped onto the one underlying Fastify instance no
   * matter which parent module imports it, so a second `AuthModule.forRoot(...)` call
   * anywhere in the graph (e.g. a feature module reaching for AuthService) would
   * register `/auth/*` twice and crash Fastify on boot with a duplicate-route error.
   * `global: true` is what lets OnboardingModule inject AuthService without importing
   * this module again — same pattern DbModule.forRoot already uses for DATABASE. */
  static forRoot(options: AuthServiceOptions): DynamicModule {
    return {
      module: AuthModule,
      controllers: [AuthController],
      providers: [AuthService, AuditLogService, { provide: AUTH_OPTIONS, useValue: options }],
      exports: [AuthService],
      global: true,
    };
  }
}
