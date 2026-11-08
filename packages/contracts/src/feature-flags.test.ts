import { describe, expect, it } from "vitest";
import { ModuleKeySchema, SetFeatureFlagSchema } from "./feature-flags.js";

describe("ModuleKeySchema", () => {
  it("accepts lowercase snake_case module names", () => {
    expect(ModuleKeySchema.parse("inventory")).toBe("inventory");
    expect(ModuleKeySchema.parse("qr_ordering")).toBe("qr_ordering");
  });

  it("rejects uppercase, spaces, leading digits, and empty strings", () => {
    expect(() => ModuleKeySchema.parse("Inventory")).toThrow();
    expect(() => ModuleKeySchema.parse("qr ordering")).toThrow();
    expect(() => ModuleKeySchema.parse("1inventory")).toThrow();
    expect(() => ModuleKeySchema.parse("")).toThrow();
  });
});

describe("SetFeatureFlagSchema", () => {
  it("accepts a boolean enabled flag", () => {
    expect(SetFeatureFlagSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });

  it("rejects a missing or non-boolean enabled field", () => {
    expect(() => SetFeatureFlagSchema.parse({})).toThrow();
    expect(() => SetFeatureFlagSchema.parse({ enabled: "yes" })).toThrow();
  });
});
