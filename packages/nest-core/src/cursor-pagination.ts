import { BadRequestException } from "@nestjs/common";
import { and, eq, lt, or, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * P2-46: keyset pagination for every large, unboundedly-growing list
 * endpoint — one row per order/shift/business day/ledger entry/
 * reconciliation flag, for as long as the restaurant keeps operating. An
 * offset page would mean counting the whole table on every request and can
 * skip or repeat rows under concurrent writes (a new row inserted ahead of
 * the current page shifts every later offset); a keyset cursor avoids both.
 *
 * Pairs with `packages/contracts`' `PageRequestSchema`/`pageResponseSchema`
 * (P1-08, never consumed by a real endpoint until this task) for the
 * wire-level query/response shapes.
 */
export interface CursorFields {
  createdAt: Date;
  id: string;
}

export function encodeCursor(fields: CursorFields): string {
  return Buffer.from(JSON.stringify({ t: fields.createdAt.toISOString(), id: fields.id })).toString("base64url");
}

/** Throws BadRequestException on anything malformed — a cursor is caller-supplied input
 * crossing a request boundary (rule 17), never trusted blindly. */
export function decodeCursor(cursor: string): CursorFields {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) throw new Error("malformed cursor payload");
    const { t, id } = parsed as Record<string, unknown>;
    if (typeof t !== "string" || typeof id !== "string") throw new Error("malformed cursor payload");
    const createdAt = new Date(t);
    if (Number.isNaN(createdAt.getTime())) throw new Error("malformed cursor timestamp");
    return { createdAt, id };
  } catch {
    throw new BadRequestException("invalid cursor");
  }
}

/**
 * The WHERE clause for "strictly after `after` in DESC (sortColumn, idColumn) order".
 * Returns undefined for the first page (no cursor yet). The caller must also apply
 * `.orderBy(desc(sortColumn), desc(idColumn))` — this condition is only correct paired
 * with that exact order, or pagination silently skips or repeats rows.
 */
export function seekCondition(sortColumn: PgColumn, idColumn: PgColumn, after: CursorFields | undefined): SQL | undefined {
  if (!after) return undefined;
  return or(lt(sortColumn, after.createdAt), and(eq(sortColumn, after.createdAt), lt(idColumn, after.id)));
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Trims an over-fetched row set down to one page. The caller must fetch `limit + 1` rows
 * (via `seekCondition` + the matching `.orderBy` + `.limit(limit + 1)`) for `hasMore` to be
 * correct — this function only looks at how many rows came back.
 */
export function toPage<T>(rows: T[], limit: number, cursorOf: (row: T) => CursorFields): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return { items, nextCursor: hasMore && last ? encodeCursor(cursorOf(last)) : null };
}
