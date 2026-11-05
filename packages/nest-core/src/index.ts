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
