import { describe, expect, it } from "vitest";
import { IdempotencyKeySchema, UuidV7Schema } from "./id.js";

describe("UuidV7Schema", () => {
  it("accepts a well-formed UUIDv7", () => {
    expect(UuidV7Schema.parse("01890a5d-ac96-774b-bcce-b302099a8057")).toBe(
      "01890a5d-ac96-774b-bcce-b302099a8057",
    );
  });

  it("rejects a UUIDv4 (wrong version nibble)", () => {
    expect(() => UuidV7Schema.parse("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toThrow();
  });

  it("rejects non-UUID garbage", () => {
    expect(() => UuidV7Schema.parse("not-a-uuid")).toThrow();
  });
});

describe("IdempotencyKeySchema", () => {
  it("accepts a non-empty string", () => {
    expect(IdempotencyKeySchema.parse("order-123")).toBe("order-123");
  });

  it("rejects an empty string", () => {
    expect(() => IdempotencyKeySchema.parse("")).toThrow();
  });
});
