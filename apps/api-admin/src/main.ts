import "reflect-metadata";
import { NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Database } from "@mezbaan/db";
import {
  createLogger,
  DATABASE,
  DEV_JWT_SECRET,
  ensureDefaultMetrics,
  GlobalExceptionFilter,
  initSentry,
  PermissionGuard,
  PermissionsService,
  PinoNestLogger,
  registerMetricsHooks,
  TenantContextGuard,
} from "@mezbaan/nest-core";
import { AppModule } from "./app.module.js";

const SERVICE_NAME = "api-admin";
const DEFAULT_PORT = 3002;

async function bootstrap(): Promise<void> {
  const logger = createLogger({ serviceName: SERVICE_NAME });
  initSentry({ serviceName: SERVICE_NAME, logger });
  ensureDefaultMetrics(SERVICE_NAME);

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: new PinoNestLogger({ serviceName: SERVICE_NAME }),
  });

  // apps/web (a browser SPA, a different origin) calls this API directly — without
  // this, every request fails the browser's CORS preflight before it even reaches a
  // guard. No credentials (cookies) are used, just a bearer token in the Authorization
  // header, so there's no need for origin-reflecting/credentialed CORS.
  app.enableCors({
    origin: (process.env.CORS_ORIGIN ?? "http://localhost:5173").split(","),
    methods: ["GET", "POST", "PATCH", "DELETE"],
  });

  app.useGlobalFilters(new GlobalExceptionFilter(logger));
  // Order matters: PermissionGuard reads getTenantContext(), which TenantContextGuard
  // must have already populated for this request.
  app.useGlobalGuards(
    new TenantContextGuard({ secret: process.env.JWT_SECRET ?? DEV_JWT_SECRET }),
    new PermissionGuard(new PermissionsService(app.get<Database>(DATABASE)), app.get(Reflector)),
  );
  registerMetricsHooks(app.getHttpAdapter().getInstance());

  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  await app.listen(port, "0.0.0.0");
  logger.info({ port }, `${SERVICE_NAME} listening`);
}

bootstrap().catch((error: unknown) => {
  console.error("Fatal startup error", error);
  process.exit(1);
});
