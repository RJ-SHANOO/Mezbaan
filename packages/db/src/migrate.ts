import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { APP_ROLE_SQL } from "./app-role.js";
import { createDb, createPool } from "./client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_ADMIN_URL = "postgres://mezbaan:mezbaan_dev_password@localhost:5432/mezbaan";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL ?? DEFAULT_ADMIN_URL;
  const pool = createPool(connectionString);
  const db = createDb(pool);

  await migrate(db, { migrationsFolder: join(__dirname, "..", "drizzle") });
  console.log("Schema migrations applied");

  // P1-32: requires pg_stat_statements to already be loaded via
  // shared_preload_libraries (infra/docker-compose.yml's postgres command for local
  // dev) — a config-only change needs a server restart to take effect, so this can't
  // fix a missing preload itself, only register the extension once it's active.
  // Tolerant on purpose: CI's plain postgres service container has no way to pass
  // that preload flag (GitHub Actions service containers don't support a custom
  // command), so this would otherwise fail every build. The extension is an
  // observability nice-to-have, not something sync/billing correctness depends on —
  // rule 14's "no module failure blocks the rest" applies here too, just at
  // migration time instead of request time.
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
    console.log("pg_stat_statements extension ensured");
  } catch (error) {
    console.warn("pg_stat_statements not available (preload not configured) — skipping:", error);
  }

  await pool.query(APP_ROLE_SQL);
  console.log("Application role ensured");

  await pool.end();
}

main().catch((error: unknown) => {
  console.error("Migration failed", error);
  process.exit(1);
});
