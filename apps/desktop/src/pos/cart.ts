import { add, money, multiply, sum, type Money } from "@mezbaan/domain";
import type { ModifierOption } from "../shared/menu-client.js";

/**
 * P2-12: the cart, kept as plain client-side state in the POS screen. This is
 * a deliberate, documented scope line — wiring these lines to the real,
 * persisted server order (OrderItemsService via api-pos) needs a cashier
 * session/access token, and the desktop app has no user-login flow yet (only
 * device pairing). Until that exists, the cart is a local staging area the
 * cashier builds up before checkout, not yet synced anywhere.
 */
export interface CartLineModifier {
  modifierOptionId: string;
  name: string;
  unitPriceMinor: string;
  currency: string;
}

export interface CartLine {
  lineId: string;
  productId: string;
  name: string;
  quantity: number;
  unitPriceMinor: string;
  currency: string;
  modifiers: CartLineModifier[];
}

export function modifierToCartLineModifier(option: ModifierOption, currency: string): CartLineModifier {
  return {
    modifierOptionId: option.id,
    name: option.name,
    unitPriceMinor: option.unitPriceMinor ?? "0",
    currency: option.currency ?? currency,
  };
}

/** A line's own total: (unit price + its modifiers' unit prices) × quantity. */
export function lineTotal(line: CartLine): Money {
  const perUnit = sum([money(BigInt(line.unitPriceMinor), line.currency), ...line.modifiers.map((m) => money(BigInt(m.unitPriceMinor), m.currency))]);
  return multiply(perUnit, line.quantity);
}

export function cartTotal(lines: CartLine[]): Money | null {
  if (lines.length === 0) return null;
  return lines.map(lineTotal).reduce((acc, next) => add(acc, next));
}

export function addLine(lines: CartLine[], line: CartLine): CartLine[] {
  return [...lines, line];
}

export function removeLine(lines: CartLine[], lineId: string): CartLine[] {
  return lines.filter((line) => line.lineId !== lineId);
}

export function updateQuantity(lines: CartLine[], lineId: string, quantity: number): CartLine[] {
  if (quantity < 1) return lines;
  return lines.map((line) => (line.lineId === lineId ? { ...line, quantity } : line));
}
