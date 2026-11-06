import { describe, expect, it } from "vitest";
import { ApproveManagerPinSchema, SetManagerPinSchema } from "./manager-pin.js";

describe("SetManagerPinSchema", () => {
  it("accepts a 4-6 digit PIN", () => {
    expect(SetManagerPinSchema.parse({ pin: "1234" })).toEqual({ pin: "1234" });
    expect(SetManagerPinSchema.parse({ pin: "123456" })).toEqual({ pin: "123456" });
  });

  it("rejects a PIN that's too short, too long, or non-numeric", () => {
    expect(() => SetManagerPinSchema.parse({ pin: "123" })).toThrow();
    expect(() => SetManagerPinSchema.parse({ pin: "1234567" })).toThrow();
    expect(() => SetManagerPinSchema.parse({ pin: "abcd" })).toThrow();
  });
});

describe("ApproveManagerPinSchema", () => {
  const base = { managerUserId: "11111111-1111-4111-8111-111111111111", pin: "1234", action: "void" as const };

  it("accepts a well-formed approval request", () => {
    expect(ApproveManagerPinSchema.parse(base)).toEqual(base);
  });

  it("rejects an action outside the known set", () => {
    expect(() => ApproveManagerPinSchema.parse({ ...base, action: "discount" })).toThrow();
  });

  it("rejects a non-UUID managerUserId", () => {
    expect(() => ApproveManagerPinSchema.parse({ ...base, managerUserId: "not-a-uuid" })).toThrow();
  });
});
