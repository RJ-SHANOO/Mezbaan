import { Catch, HttpException, HttpStatus, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Logger as PinoLogger } from "pino";
import { captureException } from "./sentry.js";

/**
 * Catches everything so a bug in one route can never crash the process or leak internals.
 * Every error is logged with context and, for 5xx/unknown failures, reported to Sentry.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const responseBody = isHttpException
      ? exception.getResponse()
      : { statusCode: status, message: "Internal server error" };

    this.logger.error(
      {
        err: exception instanceof Error ? { message: exception.message, stack: exception.stack } : exception,
        path: request.url,
        method: request.method,
        status,
      },
      "Request failed",
    );

    if (!isHttpException || status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      captureException(exception);
    }

    reply.status(status).send(responseBody);
  }
}
