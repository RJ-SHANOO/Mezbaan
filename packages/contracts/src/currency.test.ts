import { describe, expect, it } from "vitest";
import { CurrencyCodeSchema } from "./currency.js";

describe("CurrencyCodeSchema", () => {
  it("accepts a known ISO 4217 code", () => {
    expect(CurrencyCodeSchema.parse("USD")).toBe("USD");
    expect(CurrencyCodeSchema.parse("PKR")).toBe("PKR");
    expect(CurrencyCodeSchema.parse("JPY")).toBe("JPY");
  });

  it("rejects an unknown code", () => {
    expect(() => CurrencyCodeSchema.parse("XXX")).toThrow();
    expect(() => CurrencyCodeSchema.parse("usd")).toThrow(); // case-sensitive
  });
});
