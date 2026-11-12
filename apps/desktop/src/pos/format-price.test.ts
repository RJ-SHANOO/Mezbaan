import { describe, expect, it } from "vitest";
import { formatPrice } from "./format-price.js";

describe("formatPrice", () => {
  it("formats minor units into a major-unit decimal string with the currency code", () => {
    expect(formatPrice("1500", "PKR")).toBe("PKR 15.00");
  });

  it("shows a 'no price set' message when nothing has been priced yet", () => {
    expect(formatPrice(null, null)).toBe("No price set");
  });
});
