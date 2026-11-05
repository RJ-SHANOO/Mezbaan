import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { divideRound, roundToNearestCash, type RoundingMode } from "./rounding.js";
import { money } from "./money.js";

describe("divideRound() — fixed cases", () => {
  it("truncates toward zero for DOWN", () => {
    expect(divideRound(7n, 3n, "DOWN")).toBe(2n);
    expect(divideRound(-7n, 3n, "DOWN")).toBe(-2n);
  });

  it("rounds away from zero on any remainder for UP", () => {
    expect(divideRound(7n, 3n, "UP")).toBe(3n);
    expect(divideRound(-7n, 3n, "UP")).toBe(-3n);
    expect(divideRound(6n, 3n, "UP")).toBe(2n);
  });

  it("rounds half away from zero for HALF_UP", () => {
    expect(divideRound(5n, 2n, "HALF_UP")).toBe(3n);
    expect(divideRound(-5n, 2n, "HALF_UP")).toBe(-3n);
    expect(divideRound(7n, 2n, "HALF_UP")).toBe(4n);
  });

  it("rounds half toward zero for HALF_DOWN", () => {
    expect(divideRound(5n, 2n, "HALF_DOWN")).toBe(2n);
    expect(divideRound(-5n, 2n, "HALF_DOWN")).toBe(-2n);
  });

  it("rounds half to even for HALF_EVEN", () => {
    expect(divideRound(5n, 2n, "HALF_EVEN")).toBe(2n); // 2.5 -> 2 (even)
    expect(divideRound(7n, 2n, "HALF_EVEN")).toBe(4n); // 3.5 -> 4 (even)
    expect(divideRound(9n, 2n, "HALF_EVEN")).toBe(4n); // 4.5 -> 4 (even)
  });

  it("returns the exact quotient when there's no remainder, regardless of mode", () => {
    for (const mode of ["UP", "DOWN", "HALF_UP", "HALF_DOWN", "HALF_EVEN"] as const) {
      expect(divideRound(6n, 3n, mode)).toBe(2n);
    }
  });

  it("rejects division by zero", () => {
    expect(() => divideRound(1n, 0n, "HALF_UP")).toThrow();
  });
});

describe("roundToNearestCash() — fixed cases", () => {
  it("rounds to the nearer multiple", () => {
    expect(roundToNearestCash(money(303n, "USD"), 5n)).toEqual(money(305n, "USD"));
    expect(roundToNearestCash(money(302n, "USD"), 5n)).toEqual(money(300n, "USD"));
  });

  it("breaks an exact tie by rounding up (the HALF_UP default)", () => {
    expect(roundToNearestCash(money(2525n, "USD"), 50n)).toEqual(money(2550n, "USD"));
  });

  it("rejects a non-positive nearest unit", () => {
    expect(() => roundToNearestCash(money(100n, "USD"), 0n)).toThrow();
    expect(() => roundToNearestCash(money(100n, "USD"), -5n)).toThrow();
  });
});

describe("properties", () => {
  const modes: RoundingMode[] = ["UP", "DOWN", "HALF_UP", "HALF_DOWN", "HALF_EVEN"];

  it("divideRound's result, multiplied back out, is always within one denominator of the numerator", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -1_000_000_000n, max: 1_000_000_000n }),
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        fc.constantFrom(...modes),
        (numerator, denominator, mode) => {
          const result = divideRound(numerator, denominator, mode);
          const diff = result * denominator - numerator;
          const distance = diff < 0n ? -diff : diff;
          expect(distance < denominator).toBe(true);
        },
      ),
    );
  });

  it("roundToNearestCash always returns an exact multiple of nearestMinorUnits", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -1_000_000_000n, max: 1_000_000_000n }),
        fc.bigInt({ min: 1n, max: 10_000n }),
        (amountMinor, nearest) => {
          const rounded = roundToNearestCash(money(amountMinor, "USD"), nearest);
          expect(rounded.amountMinor % nearest).toBe(0n);
        },
      ),
    );
  });
});
