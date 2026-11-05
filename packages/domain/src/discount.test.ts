import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { applyFixedDiscount, applyPercentageDiscount } from "./discount.js";
import { add, money } from "./money.js";

const usd = (amountMinor: bigint) => money(amountMinor, "USD");

describe("applyPercentageDiscount() — fixed cases", () => {
  it("computes a straightforward percentage discount", () => {
    const { discount, afterDiscount } = applyPercentageDiscount(usd(1000n), 1000); // 10%
    expect(discount).toEqual(usd(100n));
    expect(afterDiscount).toEqual(usd(900n));
  });
});

describe("applyFixedDiscount() — fixed cases", () => {
  it("subtracts the fixed amount", () => {
    const { discount, afterDiscount } = applyFixedDiscount(usd(1000n), usd(300n));
    expect(discount).toEqual(usd(300n));
    expect(afterDiscount).toEqual(usd(700n));
  });

  it("clamps so the bill never goes negative", () => {
    const { discount, afterDiscount } = applyFixedDiscount(usd(500n), usd(1000n));
    expect(discount).toEqual(usd(500n));
    expect(afterDiscount).toEqual(usd(0n));
  });

  it("rejects a negative discount amount", () => {
    expect(() => applyFixedDiscount(usd(500n), usd(-100n))).toThrow();
  });
});

describe("properties", () => {
  it("discount + afterDiscount always equals the original amount", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.bigInt({ min: 0n, max: 20_000_000n }),
        (amountMinor, discountMinor) => {
          const result = applyFixedDiscount(usd(amountMinor), usd(discountMinor));
          expect(add(result.discount, result.afterDiscount)).toEqual(usd(amountMinor));
        },
      ),
    );
  });

  it("a percentage discount never exceeds the amount it's applied to", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10_000_000n }), fc.integer({ min: 0, max: 10_000 }), (amountMinor, rate) => {
        const result = applyPercentageDiscount(usd(amountMinor), rate);
        expect(result.discount.amountMinor <= amountMinor).toBe(true);
        expect(result.afterDiscount.amountMinor >= 0n).toBe(true);
      }),
    );
  });
});
