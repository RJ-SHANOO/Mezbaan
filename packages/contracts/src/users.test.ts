import { describe, expect, it } from "vitest";
import { AcceptInviteSchema, InviteUserSchema } from "./users.js";

describe("InviteUserSchema", () => {
  it("accepts a well-formed invite", () => {
    expect(InviteUserSchema.parse({ email: "a@example.test", roleKey: "cashier" })).toEqual({
      email: "a@example.test",
      roleKey: "cashier",
    });
  });

  it("rejects super_admin as an invitable role", () => {
    expect(() => InviteUserSchema.parse({ email: "a@example.test", roleKey: "super_admin" })).toThrow();
  });

  it("rejects an invalid email", () => {
    expect(() => InviteUserSchema.parse({ email: "not-an-email", roleKey: "cashier" })).toThrow();
  });
});

describe("AcceptInviteSchema", () => {
  it("rejects a password shorter than 8 characters", () => {
    expect(() =>
      AcceptInviteSchema.parse({ inviteToken: "x", displayName: "Someone", password: "short" }),
    ).toThrow();
  });
});
