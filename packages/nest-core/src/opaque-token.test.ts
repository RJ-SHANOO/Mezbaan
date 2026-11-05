import { describe, expect, it } from "vitest";
import { generateOpaqueToken, hashOpaqueToken, parseOpaqueTokenRestaurantId } from "./opaque-token.js";

const RESTAURANT_ID = "11111111-1111-1111-1111-111111111111";

describe("generateOpaqueToken() / parseOpaqueTokenRestaurantId()", () => {
  it("round-trips the restaurantId", () => {
    const token = generateOpaqueToken(RESTAURANT_ID);
    expect(parseOpaqueTokenRestaurantId(token)).toBe(RESTAURANT_ID);
  });

  it("generates a different random part each time", () => {
    expect(generateOpaqueToken(RESTAURANT_ID)).not.toBe(generateOpaqueToken(RESTAURANT_ID));
  });

  it("returns null for malformed or tampered tokens, never throws", () => {
    expect(parseOpaqueTokenRestaurantId("")).toBeNull();
    expect(parseOpaqueTokenRestaurantId("no-dot-at-all")).toBeNull();
    expect(parseOpaqueTokenRestaurantId("not-a-uuid.abcdef")).toBeNull();
    expect(parseOpaqueTokenRestaurantId(".abcdef")).toBeNull();
  });
});

describe("hashOpaqueToken()", () => {
  it("is deterministic", () => {
    const token = generateOpaqueToken(RESTAURANT_ID);
    expect(hashOpaqueToken(token)).toBe(hashOpaqueToken(token));
  });

  it("differs for different tokens", () => {
    const a = generateOpaqueToken(RESTAURANT_ID);
    const b = generateOpaqueToken(RESTAURANT_ID);
    expect(hashOpaqueToken(a)).not.toBe(hashOpaqueToken(b));
  });
});
