import { compare, isNegative, subtract, type Money } from "./money.js";
import { applyPercentage } from "./percentage.js";
import type { RoundingMode } from "./rounding.js";

export interface DiscountResult {
  readonly discount: Money;
  readonly afterDiscount: Money;
}

/** A bill can't owe the customer money, so the discount never exceeds `amount`. */
function clampDiscount(amount: Money, discount: Money): DiscountResult {
  if (isNegative(discount)) {
    throw new Error("discount: discount amount must not be negative");
  }
  const clamped = compare(discount, amount) > 0 ? amount : discount;
  return { discount: clamped, afterDiscount: subtract(amount, clamped) };
}

export function applyPercentageDiscount(
  amount: Money,
  rateBasisPoints: number | bigint,
  mode: RoundingMode = "HALF_UP",
): DiscountResult {
  return clampDiscount(amount, applyPercentage(amount, rateBasisPoints, mode));
}

export function applyFixedDiscount(amount: Money, discount: Money): DiscountResult {
  return clampDiscount(amount, discount);
}
