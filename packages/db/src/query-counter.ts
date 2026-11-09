import type { Logger } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as schema from "./schema/index.js";
import type { Database } from "./client.js";

/**
 * N+1 detection primitive (P1-33). Counts every SQL statement Drizzle actually
 * sends during the counted db's lifetime — including ones inside a withTenant
 * transaction, since the logger hook fires at Drizzle's session layer, before
 * the raw pg client, not after. A correct "list with related records" query
 * issues a constant number of statements regardless of how many rows come
 * back; an N+1 bug issues one extra statement per row. There's no real
 * "list with related records" endpoint yet (every Phase 1 list is a flat
 * SELECT), so this is exercised in query-counter.test.ts against restaurants/
 * branches — the first real one-to-many relationship in the schema — as a
 * worked example for whoever builds the first such endpoint in Phase 2+.
 */
export function createCountingDb(pool: Pool): { db: Database; count: () => number } {
  let count = 0;
  const logger: Logger = {
    logQuery: () => {
      count += 1;
    },
  };
  const db: Database = drizzle(pool, { schema, logger });
  return { db, count: () => count };
}
