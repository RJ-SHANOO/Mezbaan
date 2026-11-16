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
export {
  TaxRulesService,
  type TaxRuleRecord,
  type CreateTaxRuleParams,
  type UpdateTaxRuleParams,
  type ResolveApplicableTaxRulesParams,
  type AppliedTaxRule,
} from "./tax-rules.service.js";
export { TaxRulesController } from "./tax-rules.controller.js";
export { TaxSettingsService, type PricingMode, type TaxSettingsRecord, type SetTaxSettingsParams } from "./tax-settings.service.js";
export { TaxSettingsController } from "./tax-settings.controller.js";
export {
  ServiceChargeSettingsService,
  type ServiceChargeSettingRecord,
  type CreateServiceChargeSettingParams,
  type UpdateServiceChargeSettingParams,
  type ResolveApplicableServiceChargeParams,
} from "./service-charge-settings.service.js";
export { ServiceChargeSettingsController } from "./service-charge-settings.controller.js";
export { TaxCalculationService, type PreviewChargesParams, type PreviewedChargesRecord } from "./tax-calculation.service.js";
export { TaxCalculationController } from "./tax-calculation.controller.js";
export {
  ProductStockStatusService,
  type ProductStockStatusRecord,
  type MarkOutOfStockParams,
  type ClearOutOfStockParams,
  type ListOutOfStockParams,
} from "./product-stock-status.service.js";
export { ProductStockStatusController } from "./product-stock-status.controller.js";
export { CatalogModule } from "./catalog.module.js";
export { FloorsService, type FloorRecord, type CreateFloorParams, type UpdateFloorParams } from "./floors.service.js";
export { FloorsController } from "./floors.controller.js";
export {
  DiningTablesService,
  type TableStatus,
  type DiningTableRecord,
  type CreateDiningTableParams,
  type UpdateDiningTableParams,
  type RegenerateQrCodeParams,
} from "./dining-tables.service.js";
export { DiningTablesController } from "./dining-tables.controller.js";
export { TablesModule } from "./tables.module.js";
export {
  OrdersService,
  type OrderStatus,
  type OrderRecord,
  type OrderStatusHistoryEntry,
  type OrderTab,
  type CreateOrderParams,
  type ListOrdersParams,
  type OrderActionParams,
  type TransferTableParams,
  type MergeTablesParams,
  type MergeTablesResult,
  type SplitTableParams,
  type SplitTableResult,
  computeOrderTotal,
} from "./orders.service.js";
export { OrdersController, TableTabController } from "./orders.controller.js";
export {
  DeliveryRidersService,
  type DeliveryRiderRecord,
  type CreateDeliveryRiderParams,
  type UpdateDeliveryRiderParams,
} from "./delivery-riders.service.js";
export { DeliveryRidersController } from "./delivery-riders.controller.js";
export {
  DeliveryDetailsService,
  type DeliveryStatus,
  type DeliveryDetailsRecord,
  type SetDeliveryDetailsParams,
  type AssignRiderParams,
  type UpdateDeliveryStatusParams,
} from "./delivery-details.service.js";
export { DeliveryDetailsController } from "./delivery-details.controller.js";
export {
  OrderItemsService,
  type OrderItemRecord,
  type OrderItemModifierRecord,
  type AddOrderItemParams,
  type UpdateOrderItemParams,
  type RemoveOrderItemParams,
  type FireOrderItemsParams,
} from "./order-items.service.js";
export { OrderItemsController } from "./order-items.controller.js";
export {
  InvoicesService,
  type InvoiceRecord,
  type GenerateInvoiceParams,
  type SplitBySeatParams,
  type SplitByItemsParams,
} from "./invoices.service.js";
export { InvoicesController, InvoiceListController } from "./invoices.controller.js";
export {
  PaymentMethodSettingsService,
  type PaymentMethod,
  type PaymentMethodSettingRecord,
  type SetPaymentMethodSettingParams,
  ALL_PAYMENT_METHODS,
} from "./payment-method-settings.service.js";
export { PaymentMethodSettingsController } from "./payment-method-settings.controller.js";
export {
  PaymentsService,
  type PaymentRecord,
  type RecordPaymentParams,
  type InvoiceBalance,
} from "./payments.service.js";
export { PaymentsController, InvoiceBalanceController, InvoiceSplitController } from "./payments.controller.js";
export {
  DiscountsService,
  type DiscountReasonCodeRecord,
  type SetDiscountReasonCodeParams,
  type DiscountLimitsRecord,
  type SetDiscountLimitsParams,
  type ApplyItemDiscountParams,
  type ApplyBillDiscountParams,
  type DiscountOutcome as DiscountOutcomeRecord,
} from "./discounts.service.js";
export {
  DiscountReasonCodesController,
  DiscountLimitsController,
  OrderItemDiscountController,
  OrderDiscountController,
} from "./discounts.controller.js";
export {
  VoidsService,
  type VoidReasonCodeRecord,
  type SetVoidReasonCodeParams,
  type VoidItemParams,
  type VoidOutcome as VoidOutcomeRecord,
} from "./voids.service.js";
export { VoidReasonCodesController, OrderItemVoidController } from "./voids.controller.js";
export {
  RefundsService,
  type RefundReasonCodeRecord,
  type SetRefundReasonCodeParams,
  type RefundBalance as RefundBalanceRecord,
  type IssueRefundParams,
  type RefundRecord,
} from "./refunds.service.js";
export { RefundReasonCodesController, InvoiceRefundsController, InvoiceRefundBalanceController } from "./refunds.controller.js";
export {
  CreditCustomersService,
  type CreditCustomerRecord,
  type CreateCreditCustomerParams,
  type UpdateCreditCustomerParams,
  type CreditLedgerEntryRecord,
  type CreditBalance as CreditBalanceRecord,
  type ChargeCreditParams,
  type RecordRepaymentParams,
} from "./credit-customers.service.js";
export { CreditCustomersController } from "./credit-customers.controller.js";
export { CreditCustomerLookupController, CreditAccountController } from "./credit-account.controller.js";
export { ShiftsService, type DenominationCount, type ShiftRecord, type OpenShiftParams, type CloseShiftParams } from "./shifts.service.js";
export { ShiftsController } from "./shifts.controller.js";
export {
  CashMovementsService,
  type CashMovementDirection,
  type CashDrawerOpenTrigger,
  type CashMovementReasonCodeRecord,
  type SetCashMovementReasonCodeParams,
  type CashMovementRecord,
  type CashDrawerOpenEventRecord,
  type RecordCashMovementParams,
  type LogDrawerOpenParams,
} from "./cash-movements.service.js";
export { CashMovementReasonCodesController } from "./cash-movements.controller.js";
export { CashDrawerController } from "./cash-drawer.controller.js";
export { ShiftReportsService, type SalesSummary, type XReport as XReportRecord, type ZReport as ZReportRecord } from "./shift-reports.service.js";
export { ShiftReportsController } from "./shift-reports.controller.js";
export { BusinessDaysService, type BusinessDayStatus, type BusinessDayRecord, type CloseBusinessDayParams } from "./business-days.service.js";
export { BusinessDaysController } from "./business-days.controller.js";
export { ReceiptSettingsService, type ReceiptSettingsRecord, type SetReceiptSettingsParams } from "./receipt-settings.service.js";
export { ReceiptSettingsController, ReceiptSettingsLookupController } from "./receipt-settings.controller.js";
export {
  SalesReportsService,
  type DailySalesSummary as DailySalesSummaryRecord,
  type PaymentBreakdown as PaymentBreakdownRecord,
  type VoidReportEntry as VoidReportEntryRecord,
  type VoidReport as VoidReportRecord,
  type DiscountReportEntry as DiscountReportEntryRecord,
  type DiscountReport as DiscountReportRecord,
  type RefundReportEntry as RefundReportEntryRecord,
  type RefundReport as RefundReportRecord,
} from "./sales-reports.service.js";
export { SalesReportsController } from "./sales-reports.controller.js";
export { ReconciliationService, type ReconciliationFlagRecord } from "./reconciliation.service.js";
export { ReconciliationFlagsController } from "./reconciliation.controller.js";
export { StorageModule, S3_CLIENT, STORAGE_OPTIONS, type StorageModuleOptions } from "./storage.module.js";
export { ImageUploadService, MAX_UPLOAD_BYTES, type UploadImageParams, type UploadedImage as UploadedImageRecord } from "./image-upload.service.js";
export { ImageUploadController } from "./image-upload.controller.js";
export { RedisModule, REDIS, type RedisModuleOptions } from "./redis.module.js";
export { MenuSnapshotCacheService } from "./menu-snapshot-cache.service.js";
export { OrdersModule } from "./orders.module.js";
