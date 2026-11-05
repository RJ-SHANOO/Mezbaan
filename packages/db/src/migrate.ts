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

  await pool.query(APP_ROLE_SQL);
  console.log("Application role ensured");

  await pool.end();
}

main().catch((error: unknown) => {
  console.error("Migration failed", error);
  process.exit(1);
});
