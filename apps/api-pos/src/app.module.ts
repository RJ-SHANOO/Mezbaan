import { Module } from "@nestjs/common";
import {
  AuthModule,
  DbModule,
  DEV_JWT_SECRET,
  DevicesTerminalModule,
  HealthController,
  ManagerPinModule,
  MetricsController,
  ReleasesModule,
} from "@mezbaan/nest-core";

const DEFAULT_APP_DATABASE_URL = "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5432/mezbaan";

@Module({
  imports: [
    DbModule.forRoot({ connectionString: process.env.APP_DATABASE_URL ?? DEFAULT_APP_DATABASE_URL }),
    AuthModule.forRoot({ jwtSecret: process.env.JWT_SECRET ?? DEV_JWT_SECRET }),
    ManagerPinModule.forRoot(),
    DevicesTerminalModule.forRoot(),
    ReleasesModule.forRoot(),
  ],
  controllers: [HealthController, MetricsController],
})
export class AppModule {}
