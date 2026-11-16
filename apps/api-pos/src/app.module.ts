import { Module } from "@nestjs/common";
import {
  AuthModule,
  DbModule,
  DEV_JWT_SECRET,
  DevicesTerminalModule,
  HealthController,
  ManagerPinModule,
  MetricsController,
  OrdersModule,
  RedisModule,
  ReleasesModule,
  SyncModule,
} from "@mezbaan/nest-core";

const DEFAULT_APP_DATABASE_URL = "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5432/mezbaan";
const DEFAULT_REDIS_URL = "redis://localhost:6379";

@Module({
  imports: [
    DbModule.forRoot({ connectionString: process.env.APP_DATABASE_URL ?? DEFAULT_APP_DATABASE_URL }),
    // P2-43: menu/price snapshot caching (MenuSnapshotCacheService, via SyncModule) —
    // the first real consumer of section 3's "Cache and jobs: Valkey or Redis" entry.
    RedisModule.forRoot({ url: process.env.REDIS_URL ?? DEFAULT_REDIS_URL }),
    AuthModule.forRoot({ jwtSecret: process.env.JWT_SECRET ?? DEV_JWT_SECRET }),
    ManagerPinModule.forRoot(),
    DevicesTerminalModule.forRoot(),
    OrdersModule.forRoot(),
    ReleasesModule.forRoot(),
    SyncModule.forRoot(),
  ],
  controllers: [HealthController, MetricsController],
})
export class AppModule {}
