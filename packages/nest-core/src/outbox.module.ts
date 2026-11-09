import { Module, type DynamicModule } from "@nestjs/common";
import { OutboxService } from "./outbox.service.js";
import { OUTBOX_WORKER_OPTIONS, OutboxWorkerService, type OutboxWorkerOptions } from "./outbox-worker.service.js";

@Module({})
export class OutboxModule {
  /** Requires DbModule.forRoot(...) to already be imported, same as the other
   * feature modules. Every process that writes outbox rows only needs
   * OutboxService — pass no options (or `autoStart: false`, the default) for
   * that case. Only apps/worker should pass `autoStart: true` (with its
   * `handlers` map) so the polling loop actually runs there and nowhere else. */
  static forRoot(options: OutboxWorkerOptions = {}): DynamicModule {
    return {
      module: OutboxModule,
      providers: [OutboxService, OutboxWorkerService, { provide: OUTBOX_WORKER_OPTIONS, useValue: options }],
      exports: [OutboxService, OutboxWorkerService],
    };
  }
}
