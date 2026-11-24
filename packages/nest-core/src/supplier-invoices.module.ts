import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { PurchaseOrderSupplierInvoicesController, SupplierInvoiceMatchFlagsController, SupplierInvoicesController } from "./supplier-invoices.controller.js";
import { SupplierInvoicesService } from "./supplier-invoices.service.js";
import { SupplierLedgerService } from "./supplier-ledger.service.js";

/** P3-23: supplier invoices and three-way matching — its own module, same
 * "Purchasing and suppliers" split as SuppliersModule/PurchaseOrdersModule/
 * GoodsReceivedNotesModule. Requires DbModule.forRoot(...) to already be
 * imported, same as the other feature modules. Provides its own copy of
 * SupplierLedgerService (P3-25) — every recorded invoice charges it in
 * the same transaction, same "don't pull in a whole module for one
 * shared service" reasoning OrdersModule's own docs already give. */
@Module({})
export class SupplierInvoicesModule {
  static forRoot(): DynamicModule {
    return {
      module: SupplierInvoicesModule,
      controllers: [SupplierInvoicesController, PurchaseOrderSupplierInvoicesController, SupplierInvoiceMatchFlagsController],
      providers: [SupplierInvoicesService, AuditLogService, SupplierLedgerService],
      exports: [SupplierInvoicesService],
    };
  }
}
