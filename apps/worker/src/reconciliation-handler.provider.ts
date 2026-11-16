import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { OutboxWorkerService, ReconciliationService, type OutboxRecord } from "@mezbaan/nest-core";

/**
 * P2-26: this process' first real outbox handler — registers
 * ReconciliationService.reconcileInvoice against the "invoice.generated"
 * event InvoicesService.generate enqueues (api-pos/api-admin). Wired as an
 * OnModuleInit provider rather than passed through OutboxModule.forRoot's
 * static `handlers` option: that option is built at import time (a plain
 * useValue), before Nest has constructed ReconciliationService — see
 * OutboxWorkerService.registerHandler's own comment for the full reasoning.
 */
@Injectable()
export class ReconciliationHandlerProvider implements OnModuleInit {
  private readonly logger = new Logger(ReconciliationHandlerProvider.name);

  constructor(
    private readonly outboxWorkerService: OutboxWorkerService,
    private readonly reconciliationService: ReconciliationService,
  ) {}

  onModuleInit(): void {
    this.outboxWorkerService.registerHandler("invoice.generated", (record: OutboxRecord) => {
      const payload = record.payload as { invoiceId?: unknown };
      if (typeof payload.invoiceId !== "string") {
        throw new Error(`invoice.generated outbox event ${record.id} has no string invoiceId in its payload`);
      }
      return this.reconciliationService.reconcileInvoice({ restaurantId: record.restaurantId, invoiceId: payload.invoiceId });
    });
    this.logger.log("registered invoice.generated reconciliation handler");
  }
}
