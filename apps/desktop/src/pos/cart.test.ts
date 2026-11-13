import { describe, expect, it } from "vitest";
import { addLine, cartTotal, type CartLine, lineTotal, modifierToCartLineModifier, removeLine, updateQuantity } from "./cart.js";

function makeLine(overrides: Partial<CartLine> = {}): CartLine {
  return { lineId: "line-1", productId: "prod-1", name: "Cheeseburger", quantity: 1, unitPriceMinor: "1500", currency: "PKR", modifiers: [], ...overrides };
}

describe("cart", () => {
  it("computes a line's total as (unit price + modifiers) × quantity", () => {
    const line = makeLine({
      quantity: 2,
      modifiers: [{ modifierOptionId: "opt-1", name: "Extra Cheese", unitPriceMinor: "150", currency: "PKR" }],
    });
    const total = lineTotal(line);
    expect(total.amountMinor).toBe(3300n); // (1500 + 150) * 2
    expect(total.currency).toBe("PKR");
  });

  it("sums every line into a cart total, or null for an empty cart", () => {
    expect(cartTotal([])).toBeNull();

    const total = cartTotal([makeLine({ lineId: "a", quantity: 1 }), makeLine({ lineId: "b", quantity: 2 })]);
    expect(total?.amountMinor).toBe(4500n); // 1500 + 1500*2
  });

  it("adds, removes and updates the quantity of a line", () => {
    const lines = addLine([], makeLine());
    expect(lines).toHaveLength(1);

    const updated = updateQuantity(lines, "line-1", 3);
    expect(updated[0]?.quantity).toBe(3);

    const removed = removeLine(updated, "line-1");
    expect(removed).toEqual([]);
  });

  it("ignores a quantity update below 1 rather than letting a line go to zero or negative", () => {
    const lines = addLine([], makeLine());
    expect(updateQuantity(lines, "line-1", 0)).toEqual(lines);
  });

  it("defaults a free (unpriced) modifier option to zero in the item's own currency", () => {
    const modifier = modifierToCartLineModifier({ id: "opt-1", name: "No Onions", sortOrder: 0, unitPriceMinor: null, currency: null }, "PKR");
    expect(modifier).toEqual({ modifierOptionId: "opt-1", name: "No Onions", unitPriceMinor: "0", currency: "PKR" });
  });
});
