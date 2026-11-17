import { describe, expect, it } from "vitest";
import { computeCharges, type ChargesConfig } from "./charges.js";
import { money } from "./money.js";

const usd = (amountMinor: bigint) => money(amountMinor, "USD");

function config(overrides: Partial<ChargesConfig> = {}): ChargesConfig {
  return { pricingMode: "exclusive", taxRateBasisPoints: 0, serviceChargeRateBasisPoints: null, serviceChargeIsTaxable: null, ...overrides };
}

describe("computeCharges", () => {
  it("exclusive, no tax, no service charge: total equals subtotal", () => {
    const result = computeCharges(usd(10_000n), config());
    expect(result.tax).toEqual(usd(0n));
    expect(result.serviceCharge).toEqual(usd(0n));
    expect(result.total).toEqual(usd(10_000n));
  });

  it("exclusive with tax only: tax added on top", () => {
    const result = computeCharges(usd(10_000n), config({ taxRateBasisPoints: 1000 }));
    expect(result.tax).toEqual(usd(1_000n));
    expect(result.total).toEqual(usd(11_000n));
  });

  it("exclusive, service charge not taxable: added on top of subtotal+tax, never itself taxed", () => {
    const result = computeCharges(usd(10_000n), config({ taxRateBasisPoints: 1000, serviceChargeRateBasisPoints: 500, serviceChargeIsTaxable: false }));
    expect(result.serviceCharge).toEqual(usd(500n));
    expect(result.tax).toEqual(usd(1_000n)); // tax computed on the bare 10,000 subtotal only
    expect(result.total).toEqual(usd(11_500n)); // 10,000 + 1,000 tax + 500 service charge
  });

  it("exclusive, service charge taxable: folded into the tax base before tax is computed", () => {
    const result = computeCharges(usd(10_000n), config({ taxRateBasisPoints: 1000, serviceChargeRateBasisPoints: 500, serviceChargeIsTaxable: true }));
    expect(result.serviceCharge).toEqual(usd(500n));
    expect(result.taxBase).toEqual(usd(10_500n)); // 10,000 subtotal + 500 service charge
    expect(result.tax).toEqual(usd(1_050n)); // 10% of 10,500
    expect(result.total).toEqual(usd(11_550n)); // the exclusive breakdown's own total already includes the service charge once folded in
  });

  it("inclusive with tax: backs out the base/tax split, service charge added on top regardless of isTaxable", () => {
    const result = computeCharges(usd(11_000n), config({ pricingMode: "inclusive", taxRateBasisPoints: 1000, serviceChargeRateBasisPoints: 500, serviceChargeIsTaxable: true }));
    expect(result.tax).toEqual(usd(1_000n)); // backed out of the inclusive 11,000
    expect(result.serviceCharge).toEqual(usd(550n)); // 5% of the full 11,000 subtotal, per the documented convention
    expect(result.total).toEqual(usd(11_550n)); // 11,000 (already incl. tax) + 550 service charge
  });

  it("reconciles exactly: serviceCharge + tax-exclusive breakdown always sums to total", () => {
    const result = computeCharges(usd(7_777n), config({ taxRateBasisPoints: 1375, serviceChargeRateBasisPoints: 1000, serviceChargeIsTaxable: false }));
    expect(result.tax.amountMinor + result.serviceCharge.amountMinor + result.subtotal.amountMinor).toBe(result.total.amountMinor);
  });
});
