import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { CommissionRunService } from "./commission-run.service.js";

export const COMMISSION_RUN_SCHEDULER_OPTIONS = Symbol("COMMISSION_RUN_SCHEDULER_OPTIONS");

export interface CommissionRunSchedulerOptions {
  /** Only apps/worker should pass true — same "exactly one process actually
   * runs the loop" reasoning as OutboxWorkerService.autoStart. */
  autoStart?: boolean;
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * P3-37: the "nightly settlement job" itself — same self-scheduling
 * setTimeout shape as OutboxWorkerService (no BullMQ/cron library
 * introduced for this one job). Unlike the outbox poller, the first run
 * fires immediately on startup rather than waiting a full `intervalMs`:
 * CommissionRunService.runAll is itself a no-op for any restaurant whose
 * periods are already all processed, so an immediate run is always safe,
 * and it's what lets a freshly deployed worker catch up on any backlog
 * right away instead of waiting up to a day for the first cycle.
 */
@Injectable()
export class CommissionRunScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommissionRunScheduler.name);
  private readonly autoStart: boolean;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly commissionRunService: CommissionRunService,
    @Inject(COMMISSION_RUN_SCHEDULER_OPTIONS) options: CommissionRunSchedulerOptions,
  ) {
    this.autoStart = options.autoStart ?? false;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  onModuleInit(): void {
    if (!this.autoStart) return;
    this.runAndScheduleNext();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private runAndScheduleNext(): void {
    this.commissionRunService
      .runAll()
      .catch((error: unknown) => {
        // Rule 14: a background job failure must never crash or block
        // anything else — log with context and keep the cycle going.
        this.logger.error(`commission run cycle failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (this.stopped) return;
        this.timer = setTimeout(() => this.runAndScheduleNext(), this.intervalMs);
      });
  }
}
