import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { BusinessDaysController } from "./business-days.controller.js";
import { BusinessDaysService } from "./business-days.service.js";
import { CashDrawerController } from "./cash-drawer.controller.js";
import { CashMovementReasonCodesController } from "./cash-movements.controller.js";
import { CashMovementsService } from "./cash-movements.service.js";
import { CreditAccountController, CreditCustomerLookupController } from "./credit-account.controller.js";
import { CreditCustomersService } from "./credit-customers.service.js";
import { DeliveryDetailsController } from "./delivery-details.controller.js";
import { DeliveryDetailsService } from "./delivery-details.service.js";
import { DeliveryRidersController } from "./delivery-riders.controller.js";
import { DeliveryRidersService } from "./delivery-riders.service.js";
import { DiscountLimitsController, DiscountReasonCodesController, OrderDiscountController, OrderItemDiscountController } from "./discounts.controller.js";
import { DiscountsService } from "./discounts.service.js";
import { InvoiceListController, InvoicesController } from "./invoices.controller.js";
import { InvoicesService } from "./invoices.service.js";
import { MANAGER_PIN_OPTIONS, ManagerPinService } from "./manager-pin.service.js";
import { OrderItemsController } from "./order-items.controller.js";
import { OrderItemsService } from "./order-items.service.js";
import { OrdersController, TableTabController } from "./orders.controller.js";
import { OrdersService } from "./orders.service.js";
import { PaymentMethodSettingsService } from "./payment-method-settings.service.js";
import { InvoiceBalanceController, InvoiceSplitController, PaymentsController } from "./payments.controller.js";
import { PaymentsService } from "./payments.service.js";
import { PermissionsService } from "./permissions.service.js";
import { PriceResolutionService } from "./price-resolution.service.js";
import { ServiceChargeSettingsService } from "./service-charge-settings.service.js";
import { TaxCalculationService } from "./tax-calculation.service.js";
import { ReceiptSettingsLookupController } from "./receipt-settings.controller.js";
import { ReceiptSettingsService } from "./receipt-settings.service.js";
import { InvoiceRefundBalanceController, InvoiceRefundsController, RefundReasonCodesController } from "./refunds.controller.js";
import { RefundsService } from "./refunds.service.js";
import { ShiftReportsController } from "./shift-reports.controller.js";
import { ShiftReportsService } from "./shift-reports.service.js";
import { ShiftsController } from "./shifts.controller.js";
import { ShiftsService } from "./shifts.service.js";
import { TaxRulesService } from "./tax-rules.service.js";
import { TaxSettingsService } from "./tax-settings.service.js";
import { OrderItemVoidController, VoidReasonCodesController } from "./voids.controller.js";
import { VoidsService } from "./voids.service.js";
import { OutboxService } from "./outbox.service.js";

/** P2-09: order headers for dine-in, takeaway and delivery. P2-10 (customer/
 * address capture, rider assignment, delivery status), P2-12 (the cart),
 * P2-18 (invoice generation) and P2-19 (payments) extend the same module
 * since all are direct extensions of the order concept, not separate
 * feature areas. PriceResolutionService, the tax-rules/tax-settings/
 * service-charge-settings services and PaymentMethodSettingsService are
 * here too (same reason SyncModule needed PriceResolutionService for P2-11's
 * snapshot) — these are stateless, DB-only services also provided by
 * CatalogModule for api-admin's full catalog CRUD, but OrdersModule provides
 * its own copies directly rather than importing CatalogModule wholesale,
 * which would also pull every admin catalog-management controller into
 * api-pos ("the POS and sync API," not admin catalog management — section 4).
 * Requires DbModule.forRoot(...) to already be imported, same as the other
 * feature modules. */
@Module({})
export class OrdersModule {
  static forRoot(): DynamicModule {
    return {
      module: OrdersModule,
      controllers: [
        OrdersController,
        TableTabController,
        DeliveryRidersController,
        DeliveryDetailsController,
        OrderItemsController,
        InvoicesController,
        InvoiceListController,
        PaymentsController,
        InvoiceBalanceController,
        InvoiceSplitController,
        OrderItemDiscountController,
        OrderDiscountController,
        DiscountReasonCodesController,
        DiscountLimitsController,
        OrderItemVoidController,
        VoidReasonCodesController,
        InvoiceRefundsController,
        InvoiceRefundBalanceController,
        RefundReasonCodesController,
        CreditCustomerLookupController,
        CreditAccountController,
        ShiftsController,
        CashDrawerController,
        CashMovementReasonCodesController,
        ShiftReportsController,
        BusinessDaysController,
        ReceiptSettingsLookupController,
      ],
      providers: [
        OrdersService,
        BusinessDaysService,
        ReceiptSettingsService,
        DeliveryRidersService,
        DeliveryDetailsService,
        OrderItemsService,
        InvoicesService,
        PaymentsService,
        PaymentMethodSettingsService,
        DiscountsService,
        VoidsService,
        RefundsService,
        CreditCustomersService,
        ShiftsService,
        CashMovementsService,
        ShiftReportsService,
        ManagerPinService,
        PermissionsService,
        { provide: MANAGER_PIN_OPTIONS, useValue: {} },
        PriceResolutionService,
        TaxRulesService,
        TaxSettingsService,
        ServiceChargeSettingsService,
        TaxCalculationService,
        AuditLogService,
        // P2-26: InvoicesService.generate enqueues an "invoice.generated"
        // outbox event in the same transaction as the invoice itself —
        // without this provider, its @Optional() OutboxService stays
        // undefined and no reconciliation job is ever enqueued.
        OutboxService,
      ],
      exports: [OrdersService, DeliveryRidersService, DeliveryDetailsService, OrderItemsService, InvoicesService, PaymentsService, DiscountsService, VoidsService, RefundsService, CreditCustomersService, ShiftsService, CashMovementsService, ShiftReportsService, BusinessDaysService, ReceiptSettingsService],
    };
  }
}
