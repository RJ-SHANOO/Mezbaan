import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index.js";

export type Database = NodePgDatabase<typeof schema>;

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}

export function createDb(pool: Pool): Database {
  return drizzle(pool, { schema });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TenantContext {
  /** null for a super-admin session not acting as any specific restaurant. */
  restaurantId: string | null;
  isSuperAdmin?: boolean;
}

/**
 * Runs `fn` inside a transaction with the tenant context set via SET LOCAL, which every
 * RLS policy in ./schema reads. SET LOCAL is scoped to the transaction (not the
 * connection), which is exactly what PgBouncer transaction-pooling mode needs (section 5).
 *
 * Always sets both variables explicitly, even when there's no tenant — a pooled
 * connection's custom GUCs revert to '' (not NULL) after an earlier transaction set them,
 * so relying on "just don't set it" would silently inherit a stale value from whatever
 * ran on this connection before. The RLS policies compare these as plain text for the
 * same reason — see ./schema/rls.ts.
 *
 * This is the only place that should ever set these session variables — getting it
 * wrong here means every tenant table's "second barrier" is gone.
 */
export async function withTenant<T>(
  db: Database,
  context: TenantContext,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  if (context.restaurantId !== null && !UUID_PATTERN.test(context.restaurantId)) {
    throw new Error(`withTenant: restaurantId is not a valid UUID: ${context.restaurantId}`);
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL app.restaurant_id = '${context.restaurantId ?? ""}'`));
    await tx.execute(sql.raw(`SET LOCAL app.is_super_admin = '${context.isSuperAdmin === true ? "true" : "false"}'`));
    return fn(tx);
  });
}
