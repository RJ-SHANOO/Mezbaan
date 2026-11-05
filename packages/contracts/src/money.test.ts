import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { money } from "@mezbaan/domain";
import { MoneySchema, MoneyWireSchema, serializeMoney } from "./money.js";

describe("MoneySchema", () => {
  it("parses a valid wire payload into a domain Money", () => {
    const result = MoneySchema.parse({ amountMinor: "1234", currency: "USD" });
    expect(result).toEqual(money(1234n, "USD"));
  });

  it("parses a negative amount", () => {
    const result = MoneySchema.parse({ amountMinor: "-500", currency: "USD" });
    expect(result).toEqual(money(-500n, "USD"));
  });

  it("rejects a non-integer amountMinor string", () => {
    expect(() => MoneyWireSchema.parse({ amountMinor: "12.34", currency: "USD" })).toThrow();
    expect(() => MoneyWireSchema.parse({ amountMinor: "abc", currency: "USD" })).toThrow();
  });

  it("rejects an unsupported currency", () => {
    expect(() => MoneySchema.parse({ amountMinor: "100", currency: "XXX" })).toThrow();
  });
});

describe("serializeMoney()", () => {
  it("encodes a domain Money for JSON", () => {
    expect(serializeMoney(money(1234n, "USD"))).toEqual({ amountMinor: "1234", currency: "USD" });
    expect(serializeMoney(money(-500n, "USD"))).toEqual({ amountMinor: "-500", currency: "USD" });
  });
});

describe("properties", () => {
  it("serializeMoney -> MoneySchema.parse round-trips to an equal Money", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -10_000_000_000n, max: 10_000_000_000n }), (amountMinor) => {
        const original = money(amountMinor, "USD");
        const wire = serializeMoney(original);
        expect(MoneySchema.parse(wire)).toEqual(original);
      }),
    );
  });
});
