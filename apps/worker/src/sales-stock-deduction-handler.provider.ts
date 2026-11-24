import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { OutboxWorkerService, SalesStockDeductionService, type OutboxRecord } from "@mezbaan/nest-core";

/**
 * P3-17: registers SalesStockDeductionService.deductForInvoice against the
 * "invoice.stock_deduct" event InvoicesService.generate enqueues (api-pos/
 * api-admin) — same wiring reasoning as ReconciliationHandlerProvider
 * (P2-26) in this same directory: constructed via onModuleInit rather than
 * through OutboxModule.forRoot's static `handlers` option, since that
 * option is built before Nest has constructed SalesStockDeductionService.
 */
@Injectable()
export class SalesStockDeductionHandlerProvider implements OnModuleInit {
  private readonly logger = new Logger(SalesStockDeductionHandlerProvider.name);

  constructor(
    private readonly outboxWorkerService: OutboxWorkerService,
    private readonly salesStockDeductionService: SalesStockDeductionService,
  ) {}

  onModuleInit(): void {
    this.outboxWorkerService.registerHandler("invoice.stock_deduct", (record: OutboxRecord) => {
      const payload = record.payload as { invoiceId?: unknown };
      if (typeof payload.invoiceId !== "string") {
        throw new Error(`invoice.stock_deduct outbox event ${record.id} has no string invoiceId in its payload`);
      }
      return this.salesStockDeductionService.deductForInvoice({ restaurantId: record.restaurantId, invoiceId: payload.invoiceId }).then(() => undefined);
    });
    this.logger.log("registered invoice.stock_deduct sales stock deduction handler");
  }
}
