import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  createLogger,
  DEV_JWT_SECRET,
  ensureDefaultMetrics,
  GlobalExceptionFilter,
  initSentry,
  PinoNestLogger,
  registerMetricsHooks,
  TenantContextGuard,
} from "@mezbaan/nest-core";
import { AppModule } from "./app.module.js";

const SERVICE_NAME = "api-pos";
const DEFAULT_PORT = 3001;

async function bootstrap(): Promise<void> {
  const logger = createLogger({ serviceName: SERVICE_NAME });
  initSentry({ serviceName: SERVICE_NAME, logger });
  ensureDefaultMetrics(SERVICE_NAME);

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: new PinoNestLogger({ serviceName: SERVICE_NAME }),
  });

  app.useGlobalFilters(new GlobalExceptionFilter(logger));
  app.useGlobalGuards(new TenantContextGuard({ secret: process.env.JWT_SECRET ?? DEV_JWT_SECRET }));
  registerMetricsHooks(app.getHttpAdapter().getInstance());

  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  await app.listen(port, "0.0.0.0");
  logger.info({ port }, `${SERVICE_NAME} listening`);
}

bootstrap().catch((error: unknown) => {
  console.error("Fatal startup error", error);
  process.exit(1);
});
