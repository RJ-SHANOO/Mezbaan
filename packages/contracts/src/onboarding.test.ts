import { describe, expect, it } from "vitest";
import { SignupRequestSchema } from "./onboarding.js";

const base = {
  restaurantName: "Karahi House",
  slug: "karahi-house",
  ownerEmail: "owner@example.test",
  ownerPassword: "a long enough password",
  ownerDisplayName: "The Owner",
  firstBranchName: "Main Branch",
  timezone: "Asia/Karachi",
};

describe("SignupRequestSchema", () => {
  it("accepts a well-formed signup request", () => {
    expect(SignupRequestSchema.parse(base)).toEqual(base);
  });

  it("rejects a slug with uppercase letters, underscores, or doubled/edge hyphens", () => {
    expect(() => SignupRequestSchema.parse({ ...base, slug: "Karahi-House" })).toThrow();
    expect(() => SignupRequestSchema.parse({ ...base, slug: "karahi_house" })).toThrow();
    expect(() => SignupRequestSchema.parse({ ...base, slug: "karahi--house" })).toThrow();
    expect(() => SignupRequestSchema.parse({ ...base, slug: "-karahi-house" })).toThrow();
  });

  it("rejects a password shorter than 8 characters", () => {
    expect(() => SignupRequestSchema.parse({ ...base, ownerPassword: "short" })).toThrow();
  });

  it("rejects an invalid owner email", () => {
    expect(() => SignupRequestSchema.parse({ ...base, ownerEmail: "not-an-email" })).toThrow();
  });

  it("has no field for the commission rate — that's server-owned, never client input", () => {
    expect("commissionRateBasisPoints" in SignupRequestSchema.shape).toBe(false);
  });
});
