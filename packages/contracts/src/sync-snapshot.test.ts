import { describe, expect, it } from "vitest";
import { SnapshotContentSchema, SyncSnapshotResponseSchema } from "./sync-snapshot.js";

const emptyMenu = { branchId: "11111111-1111-1111-8111-111111111112", categories: [], products: [], variants: [], prices: [] };

describe("SnapshotContentSchema", () => {
  it("accepts a well-formed snapshot with a staff member who has no PIN set", () => {
    const content = {
      restaurantId: "11111111-1111-1111-8111-111111111111",
      branches: [{ id: "11111111-1111-1111-8111-111111111112", name: "Main", timezone: "Asia/Karachi", status: "active" }],
      staff: [
        { id: "11111111-1111-1111-8111-111111111113", displayName: "Owner", email: "o@example.test", roleKey: "owner", branchId: null, status: "active", pinHash: null },
      ],
      menu: emptyMenu,
    };
    expect(SnapshotContentSchema.parse(content)).toEqual(content);
  });

  it("accepts a menu with a resolved price for a product and rejects one with both productId and variantId set", () => {
    const menu = {
      branchId: "11111111-1111-1111-8111-111111111112",
      categories: [{ id: "11111111-1111-1111-8111-111111111114", name: "Burgers", sortOrder: 0 }],
      products: [
        {
          id: "11111111-1111-1111-8111-111111111115",
          categoryId: "11111111-1111-1111-8111-111111111114",
          name: "Cheeseburger",
          sku: null,
          barcode: null,
          imageUrl: null,
          sortOrder: 0,
        },
      ],
      variants: [],
      prices: [
        {
          productId: "11111111-1111-1111-8111-111111111115",
          orderType: "dine_in",
          unitPriceMinor: "1500",
          currency: "PKR",
          priceListId: "11111111-1111-1111-8111-111111111116",
          priceListVersion: 1,
        },
      ],
    };
    expect(SnapshotContentSchema.parse({ restaurantId: "11111111-1111-1111-8111-111111111111", branches: [], staff: [], menu }).menu).toEqual(menu);

    const badPrice = { ...menu.prices[0], variantId: "11111111-1111-1111-8111-111111111117" };
    expect(() =>
      SnapshotContentSchema.parse({ restaurantId: "11111111-1111-1111-8111-111111111111", branches: [], staff: [], menu: { ...menu, prices: [badPrice] } }),
    ).toThrow();
  });
});

describe("SyncSnapshotResponseSchema", () => {
  it("accepts a versioned, signed response envelope", () => {
    const response = { version: "2026-01-01T00:00:00.000Z", contentJson: "{}", signature: "base64signature" };
    expect(SyncSnapshotResponseSchema.parse(response)).toEqual(response);
  });
});
