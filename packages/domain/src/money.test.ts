import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  add,
  allocate,
  compare,
  CurrencyMismatchError,
  equals,
  fromMajorUnits,
  isNegative,
  isPositive,
  isZero,
  money,
  multiply,
  negate,
  subtract,
  sum,
  toMajorUnits,
} from "./money.js";
import { UnknownCurrencyError } from "./currency.js";

const amount = () => fc.bigInt({ min: -10_000_000_000n, max: 10_000_000_000n });
const usd = (amountMinor: bigint) => money(amountMinor, "USD");

describe("money()", () => {
  it("rejects an unsupported currency", () => {
    expect(() => money(100n, "XXX")).toThrow(UnknownCurrencyError);
  });

  it("rejects a non-bigint amount", () => {
    expect(() => money(100 as unknown as bigint, "USD")).toThrow(TypeError);
  });

  it("is immutable", () => {
    const m = usd(100n);
    expect(() => {
      (m as { amountMinor: bigint }).amountMinor = 200n;
    }).toThrow();
  });
});

describe("arithmetic — fixed cases", () => {
  it("adds and subtracts", () => {
    expect(add(usd(100n), usd(50n))).toEqual(usd(150n));
    expect(subtract(usd(100n), usd(50n))).toEqual(usd(50n));
  });

  it("negates", () => {
    expect(negate(usd(100n))).toEqual(usd(-100n));
    expect(negate(usd(-100n))).toEqual(usd(100n));
  });

  it("multiplies by an integer quantity", () => {
    expect(multiply(usd(150n), 3)).toEqual(usd(450n));
    expect(multiply(usd(150n), 0)).toEqual(usd(0n));
  });

  it("rejects a non-integer quantity", () => {
    expect(() => multiply(usd(100n), 1.5)).toThrow(RangeError);
  });

  it("sums a list, and rejects an empty one", () => {
    expect(sum([usd(100n), usd(200n), usd(300n)])).toEqual(usd(600n));
    expect(() => sum([])).toThrow();
  });

  it("throws on currency mismatch", () => {
    expect(() => add(usd(100n), money(100n, "PKR"))).toThrow(CurrencyMismatchError);
    expect(() => subtract(usd(100n), money(100n, "PKR"))).toThrow(CurrencyMismatchError);
    expect(() => compare(usd(100n), money(100n, "PKR"))).toThrow(CurrencyMismatchError);
  });

  it("compares and classifies", () => {
    expect(compare(usd(100n), usd(50n))).toBe(1);
    expect(compare(usd(50n), usd(100n))).toBe(-1);
    expect(compare(usd(50n), usd(50n))).toBe(0);
    expect(equals(usd(50n), usd(50n))).toBe(true);
    expect(isZero(usd(0n))).toBe(true);
    expect(isPositive(usd(1n))).toBe(true);
    expect(isNegative(usd(-1n))).toBe(true);
  });
});

describe("allocate() — fixed cases", () => {
  it("splits evenly with the remainder going to the lowest index", () => {
    expect(allocate(usd(100n), [1, 1, 1])).toEqual([usd(34n), usd(33n), usd(33n)]);
    expect(allocate(usd(10n), [1, 1, 1])).toEqual([usd(4n), usd(3n), usd(3n)]);
  });

  it("splits by weight", () => {
    expect(allocate(usd(100n), [2, 1, 1])).toEqual([usd(50n), usd(25n), usd(25n)]);
  });

  it("handles a negative total (e.g. a refund) the same way", () => {
    expect(allocate(usd(-100n), [1, 1, 1])).toEqual([usd(-34n), usd(-33n), usd(-33n)]);
  });

  it("rejects empty, negative, non-integer or all-zero weights", () => {
    expect(() => allocate(usd(100n), [])).toThrow();
    expect(() => allocate(usd(100n), [1, -1])).toThrow();
    expect(() => allocate(usd(100n), [1, 1.5])).toThrow();
    expect(() => allocate(usd(100n), [0, 0])).toThrow();
  });
});

describe("toMajorUnits() / fromMajorUnits() — fixed cases", () => {
  it("formats 2-decimal currencies", () => {
    expect(toMajorUnits(usd(100n))).toBe("1.00");
    expect(toMajorUnits(usd(5n))).toBe("0.05");
    expect(toMajorUnits(usd(-150n))).toBe("-1.50");
  });

  it("formats 0-decimal currencies", () => {
    expect(toMajorUnits(money(500n, "JPY"))).toBe("500");
  });

  it("parses decimal strings exactly, never via float math", () => {
    expect(fromMajorUnits("1.00", "USD")).toEqual(usd(100n));
    expect(fromMajorUnits("0.05", "USD")).toEqual(usd(5n));
    expect(fromMajorUnits("-1.5", "USD")).toEqual(usd(-150n));
    expect(fromMajorUnits("12", "JPY")).toEqual(money(12n, "JPY"));
  });

  it("rejects malformed input or too many fractional digits", () => {
    expect(() => fromMajorUnits("abc", "USD")).toThrow();
    expect(() => fromMajorUnits("1.005", "USD")).toThrow();
  });
});

describe("properties", () => {
  it("add is commutative and associative", () => {
    fc.assert(
      fc.property(amount(), amount(), amount(), (a, b, c) => {
        expect(add(usd(a), usd(b))).toEqual(add(usd(b), usd(a)));
        expect(add(add(usd(a), usd(b)), usd(c))).toEqual(add(usd(a), add(usd(b), usd(c))));
      }),
    );
  });

  it("subtract undoes add", () => {
    fc.assert(
      fc.property(amount(), amount(), (a, b) => {
        expect(subtract(add(usd(a), usd(b)), usd(b))).toEqual(usd(a));
      }),
    );
  });

  it("negate is its own inverse", () => {
    fc.assert(
      fc.property(amount(), (a) => {
        expect(negate(negate(usd(a)))).toEqual(usd(a));
      }),
    );
  });

  it("compare is consistent with equals/isZero/isPositive/isNegative", () => {
    fc.assert(
      fc.property(amount(), amount(), (a, b) => {
        const result = compare(usd(a), usd(b));
        if (result === 0) expect(a).toBe(b);
        if (result < 0) expect(a < b).toBe(true);
        if (result > 0) expect(a > b).toBe(true);

        const diff = usd(a - b);
        expect(isZero(diff)).toBe(a === b);
        expect(isPositive(diff)).toBe(a > b);
        expect(isNegative(diff)).toBe(a < b);
      }),
    );
  });

  it("allocate always sums back to the original total, for any weights", () => {
    fc.assert(
      fc.property(
        amount(),
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 20 }).filter((ws) =>
          ws.some((w) => w > 0),
        ),
        (total, weights) => {
          const parts = allocate(usd(total), weights);
          expect(parts).toHaveLength(weights.length);
          expect(sum(parts)).toEqual(usd(total));
        },
      ),
    );
  });

  it("round-trips through major-units formatting for 2-decimal currencies", () => {
    fc.assert(
      fc.property(amount(), (a) => {
        expect(fromMajorUnits(toMajorUnits(usd(a)), "USD")).toEqual(usd(a));
      }),
    );
  });

  it("multiply distributes over addition of quantities", () => {
    fc.assert(
      fc.property(amount(), fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: 1000 }), (a, q1, q2) => {
        expect(multiply(usd(a), q1 + q2)).toEqual(add(multiply(usd(a), q1), multiply(usd(a), q2)));
      }),
    );
  });
});
