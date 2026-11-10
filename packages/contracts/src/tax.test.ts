import { describe, expect, it } from "vitest";
import { CreateServiceChargeSettingSchema, CreateTaxRuleSchema, PreviewChargesQuerySchema, SetTaxSettingsSchema } from "./tax.js";

describe("CreateTaxRuleSchema", () => {
  it("accepts a well-formed tax rule", () => {
    expect(CreateTaxRuleSchema.parse({ name: "GST", rateBasisPoints: 1700 })).toEqual({ name: "GST", rateBasisPoints: 1700 });
  });

  it("rejects a negative rate", () => {
    expect(() => CreateTaxRuleSchema.parse({ name: "GST", rateBasisPoints: -1 })).toThrow();
  });

  it("rejects a non-integer rate", () => {
    expect(() => CreateTaxRuleSchema.parse({ name: "GST", rateBasisPoints: 17.5 })).toThrow();
  });
});

describe("SetTaxSettingsSchema", () => {
  it("accepts a restaurant-wide pricing mode", () => {
    expect(SetTaxSettingsSchema.parse({ pricingMode: "exclusive" })).toEqual({ pricingMode: "exclusive" });
  });

  it("rejects an unknown pricing mode", () => {
    expect(() => SetTaxSettingsSchema.parse({ pricingMode: "both" })).toThrow();
  });
});

describe("CreateServiceChargeSettingSchema", () => {
  it("accepts a well-formed service charge setting", () => {
    expect(CreateServiceChargeSettingSchema.parse({ rateBasisPoints: 1000, isTaxable: true })).toEqual({
      rateBasisPoints: 1000,
      isTaxable: true,
    });
  });
});

describe("PreviewChargesQuerySchema", () => {
  it("rejects a non-integer subtotalMinor", () => {
    expect(() =>
      PreviewChargesQuerySchema.parse({
        branchId: "00000000-0000-0000-0000-000000000000",
        orderType: "dine_in",
        subtotalMinor: "150.50",
        currency: "PKR",
      }),
    ).toThrow();
  });
});
