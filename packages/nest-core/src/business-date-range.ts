/**
 * Shared by SalesReportsService (P2-40) and InventoryReportsService
 * (P3-31) — both need a branch's own "business day is local time, not
 * server UTC" concept (same one P2-30 introduced) converted into a UTC
 * instant range to filter queries by. No timezone library in this
 * codebase — uses the standard "render a UTC guess through
 * Intl.DateTimeFormat, then correct by the offset it reveals" trick,
 * which is exact except right at a DST transition instant, an accepted
 * edge case for a basic pilot report.
 */
export function zonedMidnightToUtc(dateString: string, timeZone: string): Date {
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

/** `fromBusinessDate`/`toBusinessDate` are both inclusive, YYYY-MM-DD,
 * local to `timeZone` — returns the half-open `[start, end)` UTC instant
 * range covering every one of those local calendar days. Passing the
 * same date for both (SalesReportsService's own usage) covers exactly
 * one business day. */
export function businessDateRangeToUtc(fromBusinessDate: string, toBusinessDate: string, timeZone: string): { start: Date; end: Date } {
  const start = zonedMidnightToUtc(fromBusinessDate, timeZone);
  const nextDate = new Date(`${toBusinessDate}T00:00:00Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const nextDateString = nextDate.toISOString().slice(0, 10);
  const end = zonedMidnightToUtc(nextDateString, timeZone);
  return { start, end };
}
