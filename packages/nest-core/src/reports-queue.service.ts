import { HttpException, Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Queue, QueueEvents, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";

export const REPORTS_QUEUE_OPTIONS = Symbol("REPORTS_QUEUE_OPTIONS");
export const REPORTS_QUEUE_NAME = "reports";

export interface ReportsQueueOptions {
  redisUrl: string;
  /** How many report jobs this process computes at once — the actual
   * "concurrency limit" the task asks for. A heavy report is an
   * aggregation query, never something worth running many of in parallel
   * against the same database. */
  concurrency?: number;
  /** Only the process that should actually compute reports passes true —
   * same "exactly one process runs the loop" split OutboxModule/
   * CommissionRunModule already use. Every other caller (there isn't one
   * today) would just want to enqueue and await, never process. */
  autoStart?: boolean;
}

export type ReportJobHandler<TParams = unknown, TResult = unknown> = (params: TParams) => Promise<TResult>;

const DEFAULT_CONCURRENCY = 2;

/** BullMQ only preserves a failed job's `.message`/`.stack` across the
 * queue boundary, not an arbitrary exception subclass or its HTTP status —
 * without this, a report request's `BadRequestException`/`NotFoundException`
 * (e.g. an unknown branchId) would surface on the enqueuing side as a
 * generic 500 instead of the same 400/404 a direct call would have thrown.
 * Encoding {status, message} as the thrown Error's own message, then
 * decoding it back into a real HttpException in `run()`, is what keeps
 * that behavior identical to calling the report service directly. */
function serializeReportJobError(error: unknown): Error {
  if (error instanceof HttpException) {
    return new Error(JSON.stringify({ status: error.getStatus(), message: error.message }));
  }
  return error instanceof Error ? error : new Error(String(error));
}

function deserializeReportJobError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed: unknown = JSON.parse(message);
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { status?: unknown }).status === "number" && typeof (parsed as { message?: unknown }).message === "string") {
      const { status, message: innerMessage } = parsed as { status: number; message: string };
      return new HttpException(innerMessage, status);
    }
  } catch {
    // Not a serialized HttpException — a plain Error (e.g. a bug, or Redis
    // itself being unreachable) surfaces as-is below.
  }
  return new Error(message);
}

/**
 * P3-43: heavy report/export computation runs through this queue instead
 * of inline in the request's own call stack — a dedicated BullMQ queue
 * (separate from anything else that might ever use BullMQ in this
 * codebase) with its own bounded concurrency, so N simultaneous heavy
 * report requests can never all hit the database at once. The HTTP
 * contract every report endpoint already has is unchanged — `run()` is
 * still awaited synchronously from the controller, same response shape,
 * same errors — only the actual computation now happens inside a BullMQ
 * worker job rather than directly in the controller's own call.
 *
 * `registerHandler` mirrors OutboxWorkerService's own shape (P1-30/P2-26):
 * one handler per job name, registered by whichever provider owns that
 * report, independent of whether this particular process's `autoStart`
 * is even true.
 */
@Injectable()
export class ReportsQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReportsQueueService.name);
  private readonly handlers: Record<string, ReportJobHandler> = {};
  private queue!: Queue;
  private queueEvents!: QueueEvents;
  private worker: Worker | undefined;

  constructor(@Inject(REPORTS_QUEUE_OPTIONS) private readonly options: ReportsQueueOptions) {}

  onModuleInit(): void {
    // BullMQ's own blocking commands require this exact setting — it
    // refuses to construct a Queue/Worker/QueueEvents otherwise. Each of
    // the three gets its own connection deliberately (BullMQ's documented
    // requirement): sharing one ioredis client across them risks one's
    // blocking command starving the others.
    const connectionOptions = { maxRetriesPerRequest: null };
    this.queue = new Queue(REPORTS_QUEUE_NAME, { connection: new Redis(this.options.redisUrl, connectionOptions) });
    this.queueEvents = new QueueEvents(REPORTS_QUEUE_NAME, { connection: new Redis(this.options.redisUrl, connectionOptions) });

    if (!this.options.autoStart) return;

    this.worker = new Worker(
      REPORTS_QUEUE_NAME,
      async (job: Job) => {
        const handler = this.handlers[job.name];
        if (!handler) throw new Error(`no report job handler registered for "${job.name}"`);
        try {
          return await handler(job.data);
        } catch (error) {
          throw serializeReportJobError(error);
        }
      },
      { connection: new Redis(this.options.redisUrl, connectionOptions), concurrency: this.options.concurrency ?? DEFAULT_CONCURRENCY },
    );
    this.worker.on("error", (error) => {
      // Rule 16: never swallow silently — but a worker-level error (e.g. a
      // dropped Redis connection) must never crash this process (rule 14),
      // so it's logged, not rethrown.
      this.logger.error(`reports queue worker error: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queueEvents.close();
    await this.queue.close();
  }

  registerHandler<TParams, TResult>(jobName: string, handler: ReportJobHandler<TParams, TResult>): void {
    this.handlers[jobName] = handler as ReportJobHandler;
  }

  /** Enqueues `params` under `jobName` and awaits that specific job's own
   * completion — not a generic "process the next thing in the queue" wait,
   * so concurrent callers each get back only their own result. */
  async run<TParams, TResult>(jobName: string, params: TParams): Promise<TResult> {
    const job = await this.queue.add(jobName, params, { removeOnComplete: true, removeOnFail: 50 });
    try {
      return (await job.waitUntilFinished(this.queueEvents)) as TResult;
    } catch (error) {
      throw deserializeReportJobError(error);
    }
  }
}
