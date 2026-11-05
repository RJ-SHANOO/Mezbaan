import { Module } from "@nestjs/common";
import { HealthController, MetricsController } from "@mezbaan/nest-core";

// Job processing (outbox relay, commission runs, settlements, notifications)
// is added in later tasks; this module only exposes health/metrics for now.
@Module({
  controllers: [HealthController, MetricsController],
})
export class AppModule {}
