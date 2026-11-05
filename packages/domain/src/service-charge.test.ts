import { describe, expect, it } from "vitest";
import { calculateServiceCharge } from "./service-charge.js";
import { money } from "./money.js";

describe("calculateServiceCharge() — fixed cases", () => {
  it("computes a percentage of the subtotal", () => {
    expect(calculateServiceCharge(money(1000n, "USD"), 1000)).toEqual(money(100n, "USD")); // 10%
  });

  it("rounds per the given mode", () => {
    expect(calculateServiceCharge(money(999n, "USD"), 500, "HALF_UP")).toEqual(money(50n, "USD"));
    expect(calculateServiceCharge(money(999n, "USD"), 500, "DOWN")).toEqual(money(49n, "USD"));
  });
});
