import { money, type Money } from "./money.js";

export type RoundingMode = "UP" | "DOWN" | "HALF_UP" | "HALF_DOWN" | "HALF_EVEN";

/**
 * Divides two bigints and rounds the quotient per `mode`. The only primitive that ever
 * turns a fractional result (tax, discount, service-charge percentages) into an exact
 * integer — every money calculation in this package goes through it, so terminal and
 * server always land on the same minor-unit amount.
 */
export function divideRound(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) {
    throw new Error("divideRound: denominator must not be zero");
  }

  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;

  const quotient = n / d;
  const remainder = n % d;
  const sign = negative ? -1n : 1n;

  if (remainder === 0n) {
    return sign * quotient;
  }

  const doubledRemainder = remainder * 2n;

  switch (mode) {
    case "DOWN":
      return sign * quotient;
    case "UP":
      return sign * (quotient + 1n);
    case "HALF_UP":
      return sign * (doubledRemainder >= d ? quotient + 1n : quotient);
    case "HALF_DOWN":
      return sign * (doubledRemainder > d ? quotient + 1n : quotient);
    case "HALF_EVEN":
      if (doubledRemainder < d) return sign * quotient;
      if (doubledRemainder > d) return sign * (quotient + 1n);
      return sign * (quotient % 2n === 0n ? quotient : quotient + 1n);
    default:
      throw new Error(`divideRound: unknown rounding mode "${mode as string}"`);
  }
}

/**
 * Rounds a total to the nearest multiple of `nearestMinorUnits` — e.g. nearest 5 cents
 * for cash settlement in a currency without 1-cent coins. Never used for recorded sale
 * totals, only for what cash actually changes hands.
 */
export function roundToNearestCash(amount: Money, nearestMinorUnits: bigint, mode: RoundingMode = "HALF_UP"): Money {
  if (nearestMinorUnits <= 0n) {
    throw new Error("roundToNearestCash: nearestMinorUnits must be positive");
  }
  const units = divideRound(amount.amountMinor, nearestMinorUnits, mode);
  return money(units * nearestMinorUnits, amount.currency);
}
