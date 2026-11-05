import { describe, expect, it } from "vitest";
import { PERMISSION_SEED, ROLE_PERMISSIONS, ROLE_SEED } from "./seed.js";

describe("seed data consistency", () => {
  const roleKeys = new Set<string>(ROLE_SEED.map((r) => r.key));
  const permissionKeys = new Set<string>(PERMISSION_SEED.map((p) => p.key));

  it("seeds exactly the five roles from CLAUDE.md", () => {
    expect(roleKeys).toEqual(
      new Set(["super_admin", "owner", "branch_manager", "cashier", "kitchen_staff"]),
    );
  });

  it("every ROLE_PERMISSIONS key refers to a seeded role", () => {
    for (const roleKey of Object.keys(ROLE_PERMISSIONS)) {
      expect(roleKeys.has(roleKey)).toBe(true);
    }
  });

  it("has a ROLE_PERMISSIONS entry for every seeded role", () => {
    for (const roleKey of roleKeys) {
      expect(ROLE_PERMISSIONS).toHaveProperty(roleKey);
    }
  });

  it("every permission referenced in ROLE_PERMISSIONS was actually seeded", () => {
    for (const permissionKeysForRole of Object.values(ROLE_PERMISSIONS)) {
      for (const permissionKey of permissionKeysForRole) {
        expect(permissionKeys.has(permissionKey)).toBe(true);
      }
    }
  });

  it("kitchen_staff gets none of the seeded (money-adjacent) permissions, per rule 18", () => {
    expect(ROLE_PERMISSIONS["kitchen_staff"]).toEqual([]);
  });
});
