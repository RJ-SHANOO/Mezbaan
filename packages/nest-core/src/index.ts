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
export { isUniqueViolation } from "./pg-error.js";
export {
  BranchesService,
  type BranchRecord,
  type CreateBranchParams,
  type UpdateBranchParams,
} from "./branches.service.js";
export { BranchesController } from "./branches.controller.js";
export { BranchesModule } from "./branches.module.js";
export {
  UserInvitationService,
  USER_INVITATION_OPTIONS,
  type UserInvitationServiceOptions,
  type InviteUserParams,
  type AcceptInviteParams,
  type StaffUser,
  type PendingInvitation as PendingInvitationRecord,
} from "./user-invitation.service.js";
export { UserInvitationController } from "./user-invitation.controller.js";
export { UserInvitationModule } from "./user-invitation.module.js";
export {
  DeviceService,
  type DeviceRecord,
  type CreateDeviceParams,
  type GeneratePairingCodeParams,
  type PairingCodeResult,
  type RedeemPairingCodeResult,
  type RevokeDeviceParams,
} from "./device.service.js";
export { DeviceAuthGuard, CurrentDevice, DEVICE_TOKEN_HEADER } from "./device-auth.guard.js";
export { DevicesAdminController } from "./devices-admin.controller.js";
export { DevicesAdminModule } from "./devices-admin.module.js";
export { DevicesTerminalController } from "./devices-terminal.controller.js";
export { DevicesTerminalModule } from "./devices-terminal.module.js";
export { ReleasesService, type CheckForUpdateParams } from "./releases.service.js";
export { ReleasesController } from "./releases.controller.js";
export { ReleasesModule } from "./releases.module.js";
export {
  FeatureFlagsService,
  type FeatureFlagRecord,
  type SetFeatureFlagParams,
} from "./feature-flags.service.js";
export { FeatureFlagsController } from "./feature-flags.controller.js";
export { FeatureFlagsModule } from "./feature-flags.module.js";
export { SyncService, type ReceiveBatchParams } from "./sync.service.js";
export { SyncController } from "./sync.controller.js";
export { SyncModule } from "./sync.module.js";
export { SyncSnapshotService } from "./sync-snapshot.service.js";
export { SyncSnapshotController } from "./sync-snapshot.controller.js";
export {
  getSnapshotKeyPair,
  getSnapshotPublicKeyPem,
  signBytes,
  verifyBytes,
  type SnapshotKeyPair,
} from "./snapshot-signing.js";
export { OutboxService, type OutboxEntry } from "./outbox.service.js";
export {
  OutboxWorkerService,
  OUTBOX_WORKER_OPTIONS,
  type OutboxWorkerOptions,
  type OutboxHandler,
  type OutboxRecord,
  type OutboxBatchSummary,
} from "./outbox-worker.service.js";
export { OutboxModule } from "./outbox.module.js";
export { CategoriesService, type CategoryRecord, type CreateCategoryParams, type UpdateCategoryParams } from "./categories.service.js";
export { CategoriesController } from "./categories.controller.js";
export {
  ProductsService,
  type ProductRecord,
  type CreateProductParams,
  type UpdateProductParams,
  type ProductBranchAvailabilityRecord,
  type SetProductBranchAvailabilityParams,
} from "./products.service.js";
export { ProductsController } from "./products.controller.js";
export {
  ProductVariantsService,
  type ProductVariantRecord,
  type CreateProductVariantParams,
  type UpdateProductVariantParams,
} from "./product-variants.service.js";
export { ProductVariantsController } from "./product-variants.controller.js";
export {
  ModifierGroupsService,
  type ModifierGroupRecord,
  type CreateModifierGroupParams,
  type UpdateModifierGroupParams,
} from "./modifier-groups.service.js";
export { ModifierGroupsController } from "./modifier-groups.controller.js";
export {
  ModifierOptionsService,
  type ModifierOptionRecord,
  type CreateModifierOptionParams,
  type UpdateModifierOptionParams,
} from "./modifier-options.service.js";
export { ModifierOptionsController } from "./modifier-options.controller.js";
export { CombosService, type ComboRecord, type CreateComboParams, type UpdateComboParams } from "./combos.service.js";
export { CombosController } from "./combos.controller.js";
export { ComboSlotsService, type ComboSlotRecord, type CreateComboSlotParams, type UpdateComboSlotParams } from "./combo-slots.service.js";
export { ComboSlotsController } from "./combo-slots.controller.js";
export {
  ComboSlotItemsService,
  type ComboSlotItemRecord,
  type AttachComboSlotItemParams,
  type DetachComboSlotItemParams,
} from "./combo-slot-items.service.js";
export { ComboSlotItemsController } from "./combo-slot-items.controller.js";
export {
  PriceListsService,
  type OrderType,
  type PriceListRecord,
  type CreatePriceListParams,
  type UpdatePriceListParams,
  type PriceListActionParams,
} from "./price-lists.service.js";
export { PriceListsController } from "./price-lists.controller.js";
export {
  PriceListItemsService,
  type PriceListItemRecord,
  type SetPriceListItemParams,
  type RemovePriceListItemParams,
} from "./price-list-items.service.js";
export { PriceListItemsController } from "./price-list-items.controller.js";
export { PriceResolutionService, type ResolvePriceParams, type ResolvedPriceRecord } from "./price-resolution.service.js";
export { CatalogModule } from "./catalog.module.js";
