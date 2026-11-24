import { Module, type DynamicModule } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service.js";
import { SupplierLedgerController } from "./supplier-ledger.controller.js";
import { SupplierLedgerService } from "./supplier-ledger.service.js";

/** P3-25: the supplier account ledger — its own module, same "Purchasing
 * and suppliers" split as every other module in this section. Requires
 * DbModule.forRoot(...) to already be imported, same as the other
 * feature modules. */
@Module({})
export class SupplierLedgerModule {
  static forRoot(): DynamicModule {
    return {
      module: SupplierLedgerModule,
      controllers: [SupplierLedgerController],
      providers: [SupplierLedgerService, AuditLogService],
      exports: [SupplierLedgerService],
    };
  }
}
