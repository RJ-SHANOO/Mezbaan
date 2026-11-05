import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * The tenant-isolation condition every tenant table's RLS policy uses: visible only to
 * the restaurant set as the current transaction's tenant context, or to a super-admin
 * session.
 *
 * Deliberately compared as text, never cast to ::uuid/::boolean: a custom GUC that's
 * never been set in the session returns NULL from current_setting(..., true), but one
 * that WAS set via SET LOCAL earlier in the session (even in a committed, unrelated
 * transaction) reverts to '' — not NULL — once that transaction ends. ''::uuid and
 * ''::boolean both raise a hard error, which on a pooled connection would crash any
 * later transaction that doesn't happen to re-set the variable. Comparing as text
 * sidesteps that entirely: both NULL and '' simply fail to match, which is exactly the
 * fail-closed behavior we want, and neither can ever throw.
 */
export const tenantMatch = sql`restaurant_id::text = current_setting('app.restaurant_id', true) OR current_setting('app.is_super_admin', true) = 'true'`;

export const isSuperAdmin = sql`current_setting('app.is_super_admin', true) = 'true'`;

/** Same comparison as tenantMatch, but against an arbitrary column — for restaurants,
 * where the tenant check is against `id` itself, not a `restaurant_id` column. */
export function selfTenantMatch(column: PgColumn): SQL {
  return sql`${column}::text = current_setting('app.restaurant_id', true) OR ${isSuperAdmin}`;
}
