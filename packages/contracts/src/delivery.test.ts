import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AssignRiderSchema, SetDeliveryDetailsSchema, UpdateDeliveryStatusSchema } from "./delivery.js";

describe("SetDeliveryDetailsSchema", () => {
  it("accepts well-formed delivery details", () => {
    const details = { customerName: "Ali", customerPhone: "0300-1234567", addressLine1: "123 Main St" };
    expect(SetDeliveryDetailsSchema.parse(details)).toEqual(details);
  });

  it("rejects an empty address", () => {
    expect(() => SetDeliveryDetailsSchema.parse({ customerName: "Ali", customerPhone: "0300", addressLine1: "" })).toThrow();
  });
});

describe("AssignRiderSchema", () => {
  it("accepts a well-formed riderId", () => {
    const riderId = randomUUID();
    expect(AssignRiderSchema.parse({ riderId })).toEqual({ riderId });
  });
});

describe("UpdateDeliveryStatusSchema", () => {
  it("rejects an unknown status", () => {
    expect(() => UpdateDeliveryStatusSchema.parse({ status: "lost" })).toThrow();
  });
});
