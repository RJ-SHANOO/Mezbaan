import * as Sentry from "@sentry/node";
import type { Logger as PinoLogger } from "pino";

export interface InitSentryOptions {
  serviceName: string;
  logger: PinoLogger;
  dsn?: string;
  environment?: string;
  release?: string;
}

/** No-ops when no DSN is configured — a missing Sentry project must never block startup. */
export function initSentry(options: InitSentryOptions): void {
  const dsn = options.dsn ?? process.env.SENTRY_DSN;
  if (!dsn) {
    options.logger.info({ service: options.serviceName }, "Sentry disabled: no SENTRY_DSN configured");
    return;
  }

  Sentry.init({
    dsn,
    environment: options.environment ?? process.env.NODE_ENV ?? "development",
    release: options.release,
    serverName: options.serviceName,
  });
  options.logger.info({ service: options.serviceName }, "Sentry initialized");
}

export function captureException(error: unknown): void {
  Sentry.captureException(error);
}
