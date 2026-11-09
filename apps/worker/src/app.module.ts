import { Module } from "@nestjs/common";
import { DbModule, HealthController, MetricsController, OutboxModule } from "@mezbaan/nest-core";

const DEFAULT_APP_DATABASE_URL = "postgres://mezbaan_app:mezbaan_app_dev_password@localhost:5432/mezbaan";

// Commission runs, settlements and notifications are added in later tasks.
// Outbox relaying (P1-30) is the first job this process actually runs — it's
// the only process that passes autoStart: true, since every api-* process only
// needs OutboxService to write rows, not to also poll and process them.
//
// `handlers` is empty because no real business write exists yet (every actual
// producer is Phase 2+) — same situation operation_log (P1-24) and the sync
// client (P1-25) were in before their real callers existed. An event with no
// registered handler still goes through the normal retry/dead-letter path
// (rule 16: never fail silently) rather than being skipped.
@Module({
  imports: [
    DbModule.forRoot({ connectionString: process.env.APP_DATABASE_URL ?? DEFAULT_APP_DATABASE_URL }),
    OutboxModule.forRoot({ autoStart: true, handlers: {} }),
  ],
  controllers: [HealthController, MetricsController],
})
export class AppModule {}
