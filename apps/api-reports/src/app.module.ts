import { Module } from "@nestjs/common";
import { DbModule, HealthController, MetricsController } from "@mezbaan/nest-core";

const DEFAULT_APP_DATABASE_URL = "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5432/mezbaan";

@Module({
  imports: [DbModule.forRoot({ connectionString: process.env.APP_DATABASE_URL ?? DEFAULT_APP_DATABASE_URL })],
  controllers: [HealthController, MetricsController],
})
export class AppModule {}
