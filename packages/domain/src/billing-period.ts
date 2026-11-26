export type BillingCycle = "weekly" | "biweekly" | "monthly" | "quarterly";

/** Half-open interval: `end` belongs to the next period, never this one. */
export interface BillingPeriod {
  start: Date;
  end: Date;
}

// A fixed, arbitrary reference point used only to pair up ISO weeks for
// "biweekly" deterministically — 2024-01-01 is itself a Monday, so no extra
// alignment step is needed. Any restaurant's biweekly periods land on the
// same pair boundaries as any other's; nothing restaurant-specific feeds in.
const BIWEEKLY_ANCHOR_UTC_MS = Date.UTC(2024, 0, 1);
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

function startOfIsoWeekUtc(date: Date): Date {
  const dayOfWeek = date.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + diffToMonday));
}

/**
 * P3-37: the calendar period a given instant falls into for one billing
 * cycle — pure date math, no restaurant-specific anchor needed (section 6
 * lists the launch market's own invoicing rules as still an open decision,
 * so this deliberately doesn't try to guess a locale-specific billing-day
 * convention). CommissionRunService advances through consecutive periods by
 * calling this again with the previous period's own `end` — each boundary
 * this function returns is also the first instant of the next period, so
 * that always lands in the next period, never re-returns the same one.
 */
export function billingPeriodContaining(cycle: BillingCycle, date: Date): BillingPeriod {
  switch (cycle) {
    case "weekly": {
      const start = startOfIsoWeekUtc(date);
      return { start, end: new Date(start.getTime() + MS_PER_WEEK) };
    }
    case "biweekly": {
      const weekStart = startOfIsoWeekUtc(date).getTime();
      const weeksSinceAnchor = Math.floor((weekStart - BIWEEKLY_ANCHOR_UTC_MS) / MS_PER_WEEK);
      const pairIndex = Math.floor(weeksSinceAnchor / 2);
      const start = new Date(BIWEEKLY_ANCHOR_UTC_MS + pairIndex * 2 * MS_PER_WEEK);
      return { start, end: new Date(start.getTime() + 2 * MS_PER_WEEK) };
    }
    case "monthly": {
      const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
      const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
      return { start, end };
    }
    case "quarterly": {
      const quarterStartMonth = Math.floor(date.getUTCMonth() / 3) * 3;
      const start = new Date(Date.UTC(date.getUTCFullYear(), quarterStartMonth, 1));
      const end = new Date(Date.UTC(date.getUTCFullYear(), quarterStartMonth + 3, 1));
      return { start, end };
    }
  }
}
