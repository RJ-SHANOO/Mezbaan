import { describe, expect, it } from "vitest";
import { ApiErrorSchema } from "./error.js";

describe("ApiErrorSchema", () => {
  it("accepts a string message", () => {
    const body = { statusCode: 404, message: "Not Found", error: "Not Found" };
    expect(ApiErrorSchema.parse(body)).toEqual(body);
  });

  it("accepts an array message (e.g. validation errors)", () => {
    const body = { statusCode: 400, message: ["name is required", "price must be positive"] };
    expect(ApiErrorSchema.parse(body)).toEqual(body);
  });

  it("rejects a missing statusCode", () => {
    expect(() => ApiErrorSchema.parse({ message: "oops" })).toThrow();
  });
});
