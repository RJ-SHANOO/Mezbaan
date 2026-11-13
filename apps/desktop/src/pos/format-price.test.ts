import { money } from "@mezbaan/domain";
import { describe, expect, it } from "vitest";
import { formatMoney, formatPrice } from "./format-price.js";

describe("formatPrice", () => {
  it("formats minor units into a major-unit decimal string with the currency code", () => {
    expect(formatPrice("1500", "PKR")).toBe("PKR 15.00");
  });

  it("shows a 'no price set' message when nothing has been priced yet", () => {
    expect(formatPrice(null, null)).toBe("No price set");
  });
});

describe("formatMoney", () => {
  it("formats a Money value into a major-unit decimal string with its currency code", () => {
    expect(formatMoney(money(1500n, "PKR"))).toBe("PKR 15.00");
  });
});
