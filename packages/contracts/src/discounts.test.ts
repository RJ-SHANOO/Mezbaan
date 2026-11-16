import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ApplyDiscountSchema, DiscountLimitsSchema, SetDiscountLimitsSchema, SetDiscountReasonCodeSchema } from "./discounts.js";

describe("ApplyDiscountSchema", () => {
  it("accepts exactly one of percentBasisPoints or amountMinor", () => {
    expect(ApplyDiscountSchema.parse({ percentBasisPoints: 1000, reasonCode: "loyalty" })).toEqual({ percentBasisPoints: 1000, reasonCode: "loyalty" });
    expect(ApplyDiscountSchema.parse({ amountMinor: "500", reasonCode: "loyalty" })).toEqual({ amountMinor: "500", reasonCode: "loyalty" });
  });

  it("rejects both or neither", () => {
    expect(() => ApplyDiscountSchema.parse({ percentBasisPoints: 1000, amountMinor: "500", reasonCode: "loyalty" })).toThrow();
    expect(() => ApplyDiscountSchema.parse({ reasonCode: "loyalty" })).toThrow();
  });

  it("accepts optional manager approval fields", () => {
    const managerUserId = randomUUID();
    expect(ApplyDiscountSchema.parse({ percentBasisPoints: 5000, reasonCode: "manager_comp", managerUserId, managerPin: "1234" })).toEqual({
      percentBasisPoints: 5000,
      reasonCode: "manager_comp",
      managerUserId,
      managerPin: "1234",
    });
  });
});

describe("SetDiscountReasonCodeSchema", () => {
  it("accepts a code and label", () => {
    expect(SetDiscountReasonCodeSchema.parse({ code: "loyalty", label: "Loyalty discount" })).toEqual({ code: "loyalty", label: "Loyalty discount" });
  });
});

describe("SetDiscountLimitsSchema / DiscountLimitsSchema", () => {
  it("accepts null limits (meaning: no auto-approval)", () => {
    expect(SetDiscountLimitsSchema.parse({ maxUnapprovedPercentBasisPoints: null, maxUnapprovedAmountMinor: null })).toEqual({
      maxUnapprovedPercentBasisPoints: null,
      maxUnapprovedAmountMinor: null,
    });
    expect(DiscountLimitsSchema.parse({ maxUnapprovedPercentBasisPoints: null, maxUnapprovedAmountMinor: null })).toEqual({
      maxUnapprovedPercentBasisPoints: null,
      maxUnapprovedAmountMinor: null,
    });
  });
});
