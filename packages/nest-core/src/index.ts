export { createLogger, PinoNestLogger, type CreateLoggerOptions } from "./logger.js";
export { initSentry, captureException, type InitSentryOptions } from "./sentry.js";
export { HealthController, type HealthStatus } from "./health.js";
export {
  metricsRegistry,
  httpRequestDuration,
  ensureDefaultMetrics,
  registerMetricsHooks,
  MetricsController,
} from "./metrics.js";
export { GlobalExceptionFilter } from "./exception-filter.js";
export {
  DEV_JWT_SECRET,
  getTenantContext,
  signAccessToken,
  verifyAccessToken,
  TenantContextGuard,
  type AccessTokenClaims,
  type RequestTenantContext,
  type SignAccessTokenOptions,
  type TenantContextGuardOptions,
} from "./tenant-context.js";
export { hashPassword, verifyPassword } from "./password.js";
export { generateOpaqueToken, hashOpaqueToken, parseOpaqueTokenRestaurantId } from "./opaque-token.js";
export { parseOrBadRequest } from "./validation.js";
export { DbModule, DATABASE, type DbModuleOptions } from "./db.module.js";
export {
  AuthService,
  AUTH_OPTIONS,
  type AuthServiceOptions,
  type LoginResult,
} from "./auth.service.js";
export { AuthController } from "./auth.controller.js";
export { AuthModule } from "./auth.module.js";
export { RequirePermission, RequireBranchMatch, PERMISSION_KEY, BRANCH_MATCH_KEY } from "./permission.decorator.js";
export { PermissionsService } from "./permissions.service.js";
export { PermissionGuard } from "./permission.guard.js";
export { AuditLogService, type AuditLogEntry } from "./audit-log.service.js";
export {
  ManagerPinService,
  MANAGER_PIN_OPTIONS,
  type ManagerPinServiceOptions,
  type SetManagerPinParams,
  type ApproveWithManagerPinParams,
} from "./manager-pin.service.js";
export { ManagerPinController } from "./manager-pin.controller.js";
export { ManagerPinModule } from "./manager-pin.module.js";
export {
  OnboardingService,
  ONBOARDING_OPTIONS,
  type OnboardingServiceOptions,
  type SignupParams,
  type SignupResult,
} from "./onboarding.service.js";
export { OnboardingController } from "./onboarding.controller.js";
export { OnboardingModule } from "./onboarding.module.js";
