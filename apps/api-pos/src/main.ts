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

const SERVICE_NAME = "api-pos";
const DEFAULT_PORT = 3001;

async function bootstrap(): Promise<void> {
  const logger = createLogger({ serviceName: SERVICE_NAME });
  initSentry({ serviceName: SERVICE_NAME, logger });
  ensureDefaultMetrics(SERVICE_NAME);

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: new PinoNestLogger({ serviceName: SERVICE_NAME }),
  });

  // The desktop app's webview calls this API directly (device pairing, and sync
  // later) — same cross-origin situation as apps/web calling api-admin. Covers the
  // Tauri dev server (vite on 1420) and the custom-scheme origins Tauri's webview
  // uses in a packaged build (tauri:// on Windows/Linux, the equivalent on macOS).
  app.enableCors({
    origin: (process.env.CORS_ORIGIN ?? "http://localhost:1420,tauri://localhost,http://tauri.localhost").split(","),
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
