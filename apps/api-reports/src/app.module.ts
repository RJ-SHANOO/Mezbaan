import { Module } from "@nestjs/common";
import { DbModule, HealthController, MetricsController, SalesReportsController, SalesReportsService } from "@mezbaan/nest-core";

const DEFAULT_APP_DATABASE_URL = "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5432/mezbaan";

/** P2-40: api-reports' first real feature — basic pilot reports. A
 * dedicated, separately deployable process (rule: "api-reports fails →
 * selling and stock continue; reports are delayed"), so this is the only
 * place SalesReportsService gets wired up; nothing in api-pos/api-admin
 * needs it. */
@Module({
  imports: [DbModule.forRoot({ connectionString: process.env.APP_DATABASE_URL ?? DEFAULT_APP_DATABASE_URL })],
  controllers: [HealthController, MetricsController, SalesReportsController],
  providers: [SalesReportsService],
})
export class AppModule {}
