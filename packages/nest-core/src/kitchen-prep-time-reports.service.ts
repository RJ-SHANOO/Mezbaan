import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { schema, withTenant, type Database } from "@mezbaan/db";
import { DATABASE } from "./db.module.js";

export interface PrepTimeReportEntry {
  stationId: string | null;
  productId: string | null;
  variantId: string | null;
  ticketCount: number;
  avgPrepTimeSeconds: number;
  minPrepTimeSeconds: number;
  maxPrepTimeSeconds: number;
}

export interface PrepTimeReport {
  businessDate: string;
  entries: PrepTimeReportEntry[];
}

export interface PrepTimeReportParams {
  restaurantId: string;
  branchId: string;
  businessDate: string;
}

const BRANCH_NOT_FOUND = "Branch not found";

/**
 * P3-06: how long a kitchen ticket actually took, grouped by station and
 * product — bumpedAt (P3-03's kitchen_ticket_states) minus firedAt
 * (order_items.firedAt), same business-day scoping convention as P2-40's
 * SalesReportsService (its own independent copy of the zoned-midnight
 * conversion; no shared timezone util exists in this codebase to reuse —
 * same precedent BusinessDaysService's todayFor already set).
 *
 * A ticket's prep time is counted once per product it contains — a
 * 3-item ticket bumped after 6 minutes contributes that same 6-minute
 * duration to each of its 3 products' own averages, which is the right
 * behavior for "how long does cooking THIS product typically take,"
 * not "how long did this ticket as a whole take" (a station-level-only
 * view would already get that from grouping with productId left out).
 */
@Injectable()
export class KitchenPrepTimeReportsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async getReport(params: PrepTimeReportParams): Promise<PrepTimeReport> {
    return withTenant(this.db, { restaurantId: params.restaurantId }, async (tx) => {
      const { start, end } = await this.businessDayRange(tx, params.branchId, params.businessDate);

      const bumpedTickets = await tx
        .select()
        .from(schema.kitchenTicketStates)
        .where(and(eq(schema.kitchenTicketStates.branchId, params.branchId), gte(schema.kitchenTicketStates.bumpedAt, start), lt(schema.kitchenTicketStates.bumpedAt, end)));
      if (bumpedTickets.length === 0) return { businessDate: params.businessDate, entries: [] };

      const orderIds = [...new Set(bumpedTickets.map((t) => t.orderId))];
      const items = await tx.select().from(schema.orderItems).where(inArray(schema.orderItems.orderId, orderIds));
      const itemsByOrderAndFiredAt = new Map<string, Array<(typeof items)[number]>>();
      for (const item of items) {
        if (item.firedAt === null) continue;
        const key = `${item.orderId}:${item.firedAt.getTime()}`;
        const group = itemsByOrderAndFiredAt.get(key) ?? [];
        group.push(item);
        itemsByOrderAndFiredAt.set(key, group);
      }

      const durationsByKey = new Map<string, number[]>();
      for (const ticket of bumpedTickets) {
        const ticketItems = itemsByOrderAndFiredAt.get(`${ticket.orderId}:${ticket.firedAt.getTime()}`) ?? [];
        const prepTimeSeconds = (ticket.bumpedAt.getTime() - ticket.firedAt.getTime()) / 1000;
        for (const item of ticketItems) {
          const key = `${ticket.stationId ?? "unrouted"}:${item.productId ?? "none"}:${item.variantId ?? "none"}`;
          const durations = durationsByKey.get(key) ?? [];
          durations.push(prepTimeSeconds);
          durationsByKey.set(key, durations);
        }
      }

      const entries: PrepTimeReportEntry[] = [];
      for (const [key, durations] of durationsByKey) {
        const [stationId, productId, variantId] = key.split(":");
        entries.push({
          stationId: stationId === "unrouted" ? null : stationId!,
          productId: productId === "none" ? null : productId!,
          variantId: variantId === "none" ? null : variantId!,
          ticketCount: durations.length,
          avgPrepTimeSeconds: durations.reduce((sum, d) => sum + d, 0) / durations.length,
          minPrepTimeSeconds: Math.min(...durations),
          maxPrepTimeSeconds: Math.max(...durations),
        });
      }

      return { businessDate: params.businessDate, entries };
    });
  }

  /** Same zoned-midnight-to-UTC conversion SalesReportsService already
   * uses, duplicated rather than imported — see this class's own docs. */
  private async businessDayRange(tx: Database, branchId: string, businessDate: string): Promise<{ start: Date; end: Date }> {
    const rows = await tx.select({ timezone: schema.branches.timezone }).from(schema.branches).where(eq(schema.branches.id, branchId));
    const branch = rows[0];
    if (!branch) throw new NotFoundException(BRANCH_NOT_FOUND);

    const start = zonedMidnightToUtc(businessDate, branch.timezone);
    const nextDate = new Date(`${businessDate}T00:00:00Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    const nextDateString = nextDate.toISOString().slice(0, 10);
    const end = zonedMidnightToUtc(nextDateString, branch.timezone);

    return { start, end };
  }
}

function zonedMidnightToUtc(dateString: string, timeZone: string): Date {
  const guess = new Date(`${dateString}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(guess);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");

  const renderedAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  const offsetMs = renderedAsUtc - guess.getTime();
  return new Date(guess.getTime() - offsetMs);
}
