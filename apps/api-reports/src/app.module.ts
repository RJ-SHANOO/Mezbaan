import { Module } from "@nestjs/common";
import { HealthController, MetricsController } from "@mezbaan/nest-core";

@Module({
  controllers: [HealthController, MetricsController],
})
export class AppModule {}
