import pino, { type Logger as PinoLogger } from "pino";
import type { LoggerService, LogLevel } from "@nestjs/common";

const REDACT_PATHS = [
  "req.headers.authorization",
  "*.password",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.secret",
  "*.cardNumber",
  "*.cvv",
];

export interface CreateLoggerOptions {
  serviceName: string;
  level?: string;
}

export function createLogger(options: CreateLoggerOptions): PinoLogger {
  return pino({
    name: options.serviceName,
    level: options.level ?? process.env.LOG_LEVEL ?? "info",
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

const LEVEL_MAP: Record<LogLevel, pino.Level> = {
  log: "info",
  error: "error",
  warn: "warn",
  debug: "debug",
  verbose: "trace",
  fatal: "fatal",
};

/** Adapts a pino logger to Nest's LoggerService so framework logs are structured JSON too. */
export class PinoNestLogger implements LoggerService {
  private readonly logger: PinoLogger;

  constructor(options: CreateLoggerOptions) {
    this.logger = createLogger(options);
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write("log", message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write("error", message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write("warn", message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write("debug", message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write("verbose", message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write("fatal", message, optionalParams);
  }

  private write(level: LogLevel, message: unknown, optionalParams: unknown[]): void {
    const context = optionalParams.length > 0 ? optionalParams[optionalParams.length - 1] : undefined;
    const pinoLevel = LEVEL_MAP[level];
    this.logger[pinoLevel]({ context }, typeof message === "string" ? message : JSON.stringify(message));
  }
}
