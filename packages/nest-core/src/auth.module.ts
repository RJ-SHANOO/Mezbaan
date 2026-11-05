import { Module, type DynamicModule } from "@nestjs/common";
import { AUTH_OPTIONS, AuthService, type AuthServiceOptions } from "./auth.service.js";
import { AuthController } from "./auth.controller.js";

@Module({})
export class AuthModule {
  /** Requires DbModule.forRoot(...) to already be imported (for the DATABASE provider)
   * — AuthService depends on it but this module doesn't re-provide it. */
  static forRoot(options: AuthServiceOptions): DynamicModule {
    return {
      module: AuthModule,
      controllers: [AuthController],
      providers: [AuthService, { provide: AUTH_OPTIONS, useValue: options }],
      exports: [AuthService],
    };
  }
}
