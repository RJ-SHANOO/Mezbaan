import { Module, type DynamicModule } from "@nestjs/common";
import { REPORTS_QUEUE_OPTIONS, ReportsQueueService, type ReportsQueueOptions } from "./reports-queue.service.js";

@Module({})
export class ReportsQueueModule {
  /** Every process that enqueues report jobs needs this imported — only
   * api-reports (the one that also computes them) should pass
   * `autoStart: true`, the same split OutboxModule/CommissionRunModule use. */
  static forRoot(options: ReportsQueueOptions): DynamicModule {
    return {
      module: ReportsQueueModule,
      providers: [ReportsQueueService, { provide: REPORTS_QUEUE_OPTIONS, useValue: options }],
      exports: [ReportsQueueService],
      global: true,
    };
  }
}
