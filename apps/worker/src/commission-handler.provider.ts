import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { CommissionService, OutboxWorkerService, type OutboxRecord } from "@mezbaan/nest-core";

/**
 * P3-34: registers CommissionService.processPayment against the
 * "payment.recorded" event PaymentsService.record enqueues (api-pos) —
 * same wiring reasoning as ReconciliationHandlerProvider (P2-26) and
 * SalesStockDeductionHandlerProvider (P3-17) in this same directory.
 *
 * P3-35: also registers processRefund against the "refund.issued" event
 * RefundsService.issue enqueues — the compensating reversal for a
 * commission charge already paid out, same handler-per-event-type shape.
 */
@Injectable()
export class CommissionHandlerProvider implements OnModuleInit {
  private readonly logger = new Logger(CommissionHandlerProvider.name);

  constructor(
    private readonly outboxWorkerService: OutboxWorkerService,
    private readonly commissionService: CommissionService,
  ) {}

  onModuleInit(): void {
    this.outboxWorkerService.registerHandler("payment.recorded", (record: OutboxRecord) => {
      const payload = record.payload as { paymentId?: unknown };
      if (typeof payload.paymentId !== "string") {
        throw new Error(`payment.recorded outbox event ${record.id} has no string paymentId in its payload`);
      }
      return this.commissionService.processPayment({ restaurantId: record.restaurantId, paymentId: payload.paymentId }).then(() => undefined);
    });
    this.outboxWorkerService.registerHandler("refund.issued", (record: OutboxRecord) => {
      const payload = record.payload as { refundId?: unknown };
      if (typeof payload.refundId !== "string") {
        throw new Error(`refund.issued outbox event ${record.id} has no string refundId in its payload`);
      }
      return this.commissionService.processRefund({ restaurantId: record.restaurantId, refundId: payload.refundId }).then(() => undefined);
    });
    this.logger.log("registered payment.recorded and refund.issued commission handlers");
  }
}
