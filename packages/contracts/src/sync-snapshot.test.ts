import { describe, expect, it } from "vitest";
import { SnapshotContentSchema, SyncSnapshotResponseSchema } from "./sync-snapshot.js";

describe("SnapshotContentSchema", () => {
  it("accepts a well-formed snapshot with a staff member who has no PIN set", () => {
    const content = {
      restaurantId: "11111111-1111-1111-8111-111111111111",
      branches: [{ id: "11111111-1111-1111-8111-111111111112", name: "Main", timezone: "Asia/Karachi", status: "active" }],
      staff: [
        { id: "11111111-1111-1111-8111-111111111113", displayName: "Owner", email: "o@example.test", roleKey: "owner", branchId: null, status: "active", pinHash: null },
      ],
    };
    expect(SnapshotContentSchema.parse(content)).toEqual(content);
  });
});

describe("SyncSnapshotResponseSchema", () => {
  it("accepts a versioned, signed response envelope", () => {
    const response = { version: "2026-01-01T00:00:00.000Z", contentJson: "{}", signature: "base64signature" };
    expect(SyncSnapshotResponseSchema.parse(response)).toEqual(response);
  });
});
