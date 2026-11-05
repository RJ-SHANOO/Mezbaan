import { Body, Controller, Post } from "@nestjs/common";
import {
  LoginRequestSchema,
  LogoutRequestSchema,
  PasswordResetConfirmSchema,
  PasswordResetRequestSchema,
  RefreshRequestSchema,
} from "@mezbaan/contracts";
import { AuthService, type LoginResult } from "./auth.service.js";
import { parseOrBadRequest } from "./validation.js";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("login")
  login(@Body() body: unknown): Promise<LoginResult> {
    const request = parseOrBadRequest(LoginRequestSchema, body);
    return this.authService.login(request);
  }

  @Post("refresh")
  refresh(@Body() body: unknown): Promise<LoginResult> {
    const { refreshToken } = parseOrBadRequest(RefreshRequestSchema, body);
    return this.authService.refresh(refreshToken);
  }

  @Post("logout")
  async logout(@Body() body: unknown): Promise<{ ok: true }> {
    const { refreshToken } = parseOrBadRequest(LogoutRequestSchema, body);
    await this.authService.logout(refreshToken);
    return { ok: true };
  }

  @Post("password-reset/request")
  async requestPasswordReset(@Body() body: unknown): Promise<{ resetToken: string } | { ok: true }> {
    const request = parseOrBadRequest(PasswordResetRequestSchema, body);
    const result = await this.authService.requestPasswordReset(request);
    // Always a 200 with the same shape family whether or not the account exists —
    // no enumeration. The reset token itself only comes back because there's no
    // email/SMS delivery wired up yet; a real provider would remove this entirely.
    return result ?? { ok: true };
  }

  @Post("password-reset/confirm")
  async confirmPasswordReset(@Body() body: unknown): Promise<{ ok: true }> {
    const request = parseOrBadRequest(PasswordResetConfirmSchema, body);
    await this.authService.resetPassword(request);
    return { ok: true };
  }
}
