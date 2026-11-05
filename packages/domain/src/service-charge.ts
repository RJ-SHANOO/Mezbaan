import type { Money } from "./money.js";
import { applyPercentage } from "./percentage.js";
import type { RoundingMode } from "./rounding.js";

/**
 * A percentage charge on top of the subtotal (e.g. a 10% service charge). Whether it's
 * computed before or after tax, and whether it's itself taxable, is a per-restaurant
 * setting (P2-05) — this just computes the amount for whatever base the caller passes.
 */
export function calculateServiceCharge(
  subtotal: Money,
  rateBasisPoints: number | bigint,
  mode: RoundingMode = "HALF_UP",
): Money {
  return applyPercentage(subtotal, rateBasisPoints, mode);
}
