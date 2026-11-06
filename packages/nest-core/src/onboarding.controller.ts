import { Body, Controller, Post } from "@nestjs/common";
import { SignupRequestSchema, type SignupResponse } from "@mezbaan/contracts";
import { AuthService } from "./auth.service.js";
import { OnboardingService } from "./onboarding.service.js";
import { parseOrBadRequest } from "./validation.js";

@Controller("onboarding")
export class OnboardingController {
  constructor(
    private readonly onboardingService: OnboardingService,
    private readonly authService: AuthService,
  ) {}

  /** Anonymous route — there's no token yet, which is exactly what TenantContextGuard
   * already allows (it only rejects a present-but-invalid token, not a missing one). */
  @Post("signup")
  async signup(@Body() body: unknown): Promise<SignupResponse> {
    const request = parseOrBadRequest(SignupRequestSchema, body);
    const { restaurantId, branchId } = await this.onboardingService.signup(request);

    // Log the owner in immediately rather than duplicating session-issuing logic —
    // reuses AuthService's already-tested login path instead of a second one.
    const session = await this.authService.login({
      restaurantSlug: request.slug,
      email: request.ownerEmail,
      password: request.ownerPassword,
    });

    return { ...session, restaurantId, branchId };
  }
}
