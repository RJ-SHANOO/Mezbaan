import { add, money, subtract, type Money } from "./money.js";
import { applyPercentage, BASIS_POINTS_SCALE } from "./percentage.js";
import { divideRound, type RoundingMode } from "./rounding.js";

export interface TaxBreakdown {
  readonly base: Money;
  readonly tax: Money;
  readonly total: Money;
}

/** Price excludes tax: tax is added on top, so total = base + tax. */
export function calculateExclusiveTax(
  base: Money,
  rateBasisPoints: number | bigint,
  mode: RoundingMode = "HALF_UP",
): TaxBreakdown {
  const tax = applyPercentage(base, rateBasisPoints, mode);
  return { base, tax, total: add(base, tax) };
}

/**
 * Price already includes tax: back out the base/tax split. `tax` is derived as
 * `total - base` rather than rounded independently, so base + tax always reconciles
 * to exactly `total` — never off by a minor unit from independent rounding.
 */
export function calculateInclusiveTax(
  total: Money,
  rateBasisPoints: number | bigint,
  mode: RoundingMode = "HALF_UP",
): TaxBreakdown {
  const rate = typeof rateBasisPoints === "bigint" ? rateBasisPoints : BigInt(rateBasisPoints);
  const baseAmountMinor = divideRound(total.amountMinor * BASIS_POINTS_SCALE, BASIS_POINTS_SCALE + rate, mode);
  const base = money(baseAmountMinor, total.currency);
  const tax = subtract(total, base);
  return { base, tax, total };
}
