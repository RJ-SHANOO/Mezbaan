import { describe, expect, it } from "vitest";
import { PaymentMethodSettingSchema, SetPaymentMethodSettingSchema } from "./payment-method-settings.js";

describe("SetPaymentMethodSettingSchema", () => {
  it("accepts a known method and a boolean", () => {
    expect(SetPaymentMethodSettingSchema.parse({ method: "cash", enabled: false })).toEqual({ method: "cash", enabled: false });
  });

  it("rejects an unknown method", () => {
    expect(() => SetPaymentMethodSettingSchema.parse({ method: "crypto", enabled: true })).toThrow();
  });
});

describe("PaymentMethodSettingSchema", () => {
  it("accepts a well-formed setting", () => {
    const setting = {
      id: "00000000-0000-0000-0000-000000000000",
      method: "wallet" as const,
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(PaymentMethodSettingSchema.parse(setting)).toEqual(setting);
  });
});
