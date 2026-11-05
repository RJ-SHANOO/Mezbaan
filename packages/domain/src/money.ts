import { minorUnitExponent } from "./currency.js";

/**
 * An exact amount in a currency's minor units (e.g. cents), as a bigint.
 * Never a float — see CLAUDE.md rule 5. Immutable; all operations return new values.
 */
export interface Money {
  readonly amountMinor: bigint;
  readonly currency: string;
}

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Currency mismatch: ${a} vs ${b}`);
    this.name = "CurrencyMismatchError";
  }
}

export function money(amountMinor: bigint, currency: string): Money {
  if (typeof amountMinor !== "bigint") {
    throw new TypeError("money: amountMinor must be a bigint");
  }
  minorUnitExponent(currency); // throws UnknownCurrencyError for an unsupported code
  return Object.freeze({ amountMinor, currency });
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.amountMinor, a.currency);
}

/** Scales by an integer quantity (e.g. unit price x cart quantity). Fractional/percentage
 * multipliers need a rounding policy and belong in the tax/discount utilities instead. */
export function multiply(a: Money, quantity: bigint | number): Money {
  const q = typeof quantity === "bigint" ? quantity : BigInt(quantity);
  return money(a.amountMinor * q, a.currency);
}

export function sum(monies: readonly Money[]): Money {
  if (monies.length === 0) {
    throw new Error("sum: monies must not be empty");
  }
  return monies.reduce(add);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

export function isZero(a: Money): boolean {
  return a.amountMinor === 0n;
}

export function isPositive(a: Money): boolean {
  return a.amountMinor > 0n;
}

export function isNegative(a: Money): boolean {
  return a.amountMinor < 0n;
}

/**
 * Splits `total` into `weights.length` parts using non-negative integer weights, such
 * that the parts always sum back to exactly `total` — the classic "allocate" operation
 * (Fowler's Money pattern). Any leftover minor units go to the parts with the largest
 * fractional remainder, ties broken by weight index, so the result is deterministic.
 */
export function allocate(total: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) {
    throw new Error("allocate: weights must not be empty");
  }

  const weightsBig = weights.map((w) => {
    if (!Number.isInteger(w) || w < 0) {
      throw new Error("allocate: weights must be non-negative integers");
    }
    return BigInt(w);
  });
  const weightSum = weightsBig.reduce((s, w) => s + w, 0n);
  if (weightSum === 0n) {
    throw new Error("allocate: weights must not all be zero");
  }

  const sign = total.amountMinor < 0n ? -1n : 1n;
  const totalAbs = sign < 0n ? -total.amountMinor : total.amountMinor;

  const shares = weightsBig.map((w) => (totalAbs * w) / weightSum);
  const allocated = shares.reduce((s, share) => s + share, 0n);
  let remainder = totalAbs - allocated;

  const byRemainder = weightsBig
    .map((w, index) => ({ index, frac: (totalAbs * w) % weightSum }))
    .sort((a, b) => (b.frac > a.frac ? 1 : b.frac < a.frac ? -1 : a.index - b.index));

  for (const { index } of byRemainder) {
    if (remainder <= 0n) break;
    shares[index] = (shares[index] ?? 0n) + 1n;
    remainder -= 1n;
  }

  return shares.map((shareAbs) => money(shareAbs * sign, total.currency));
}

const MAJOR_UNITS_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Formats for display only — never feed this back into arithmetic. */
export function toMajorUnits(m: Money): string {
  const exponent = minorUnitExponent(m.currency);
  if (exponent === 0) {
    return m.amountMinor.toString();
  }
  const negative = m.amountMinor < 0n;
  const abs = negative ? -m.amountMinor : m.amountMinor;
  const divisor = 10n ** BigInt(exponent);
  const whole = abs / divisor;
  const fraction = (abs % divisor).toString().padStart(exponent, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** Parses a decimal string (never a float) into exact minor units. */
export function fromMajorUnits(value: string, currency: string): Money {
  const exponent = minorUnitExponent(currency);
  const match = MAJOR_UNITS_PATTERN.exec(value.trim());
  if (!match) {
    throw new Error(`fromMajorUnits: "${value}" is not a valid decimal amount`);
  }
  const [, sign, wholePart, fractionPart = ""] = match;
  if (fractionPart.length > exponent) {
    throw new Error(
      `fromMajorUnits: "${value}" has more fractional digits than ${currency} supports (${exponent})`,
    );
  }
  const paddedFraction = fractionPart.padEnd(exponent, "0");
  const amountMinor = BigInt(`${wholePart}${paddedFraction}`) * (sign === "-" ? -1n : 1n);
  return money(amountMinor, currency);
}
