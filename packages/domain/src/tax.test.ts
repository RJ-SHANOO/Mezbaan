import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { calculateExclusiveTax, calculateInclusiveTax } from "./tax.js";
import { add, money } from "./money.js";

const usd = (amountMinor: bigint) => money(amountMinor, "USD");

describe("calculateExclusiveTax() — fixed cases", () => {
  it("adds tax on top of an exact base", () => {
    const { base, tax, total } = calculateExclusiveTax(usd(1000n), 1000); // 10.00 @ 10%
    expect(base).toEqual(usd(1000n));
    expect(tax).toEqual(usd(100n));
    expect(total).toEqual(usd(1100n));
  });

  it("rounds the tax amount per the given mode", () => {
    // 9.99 @ 5% = 0.4995 -> HALF_UP rounds to 0.50
    expect(calculateExclusiveTax(usd(999n), 500, "HALF_UP").tax).toEqual(usd(50n));
    expect(calculateExclusiveTax(usd(999n), 500, "DOWN").tax).toEqual(usd(49n));
  });
});

describe("calculateInclusiveTax() — fixed cases", () => {
  it("backs out the base/tax split from a tax-inclusive total", () => {
    const { base, tax, total } = calculateInclusiveTax(usd(1100n), 1000); // 11.00 incl. 10% tax
    expect(base).toEqual(usd(1000n));
    expect(tax).toEqual(usd(100n));
    expect(total).toEqual(usd(1100n));
  });
});

describe("properties", () => {
  const amount = () => fc.bigInt({ min: 0n, max: 10_000_000n });
  const rateBasisPoints = () => fc.integer({ min: 0, max: 5_000 }); // 0% to 50%

  it("exclusive tax always reconciles: base + tax === total", () => {
    fc.assert(
      fc.property(amount(), rateBasisPoints(), (base, rate) => {
        const result = calculateExclusiveTax(usd(base), rate);
        expect(add(result.base, result.tax)).toEqual(result.total);
      }),
    );
  });

  it("inclusive tax always reconciles exactly, by construction: base + tax === total", () => {
    fc.assert(
      fc.property(amount(), rateBasisPoints(), (total, rate) => {
        const result = calculateInclusiveTax(usd(total), rate);
        expect(add(result.base, result.tax)).toEqual(result.total);
        expect(result.total).toEqual(usd(total));
      }),
    );
  });
});
