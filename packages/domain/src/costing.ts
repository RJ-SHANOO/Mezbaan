import { CurrencyMismatchError, money, type Money } from "./money.js";
import { divideRound, type RoundingMode } from "./rounding.js";

/** Matches this schema's own numeric(18,6) convention for physical
 * quantities (stock_ledger.quantityDelta, inventory_item_unit_conversions.
 * factorToBaseUnit) — scaling to a fixed-point bigint at this precision
 * keeps every computation below exact, never a float, the same way
 * money.ts's own functions never are (rule 5). */
const QUANTITY_SCALE = 1_000_000n;

function scaleQuantity(quantity: number): bigint {
  return BigInt(Math.round(quantity * 1_000_000));
}

/**
 * Multiplies a per-unit cost by a fractional physical quantity (e.g.
 * 2.345 kg at a Rs 50.00/kg unit cost) — money.ts's own `multiply` only
 * accepts an integer multiplier (a sale's item count, not a continuous
 * measure), so this is the quantity-aware counterpart P3-11's costing
 * needs. Stays in exact bigint arithmetic throughout; only the input
 * `quantity` is ever a float, and only because that's what a physical
 * measurement is.
 */
export function scaleMoneyByQuantity(unitCost: Money, quantity: number, mode: RoundingMode = "HALF_UP"): Money {
  const scaledQuantity = scaleQuantity(quantity);
  return money(divideRound(unitCost.amountMinor * scaledQuantity, QUANTITY_SCALE, mode), unitCost.currency);
}

/**
 * Blends an incoming costed quantity into a running weighted-average
 * unit cost — the core of P3-11's costing method:
 * `newAvg = (currentQty × currentAvg + incomingQty × incomingCost) / (currentQty + incomingQty)`.
 * `currentAvgCost` is `null` when this item has never had a costed
 * movement at this location before — the result is then just
 * `incomingCost` itself, nothing to blend with. Returns a new per-unit
 * cost (not multiplied out), same shape as the inputs.
 */
export function blendWeightedAverageCost(
  currentQuantity: number,
  currentAvgCost: Money | null,
  incomingQuantity: number,
  incomingCost: Money,
  mode: RoundingMode = "HALF_UP",
): Money {
  if (currentAvgCost !== null && currentAvgCost.currency !== incomingCost.currency) {
    throw new CurrencyMismatchError(currentAvgCost.currency, incomingCost.currency);
  }

  const currentScaled = scaleQuantity(currentQuantity);
  const incomingScaled = scaleQuantity(incomingQuantity);
  const totalScaled = currentScaled + incomingScaled;
  if (totalScaled <= 0n) return incomingCost;

  const currentValue = currentAvgCost ? currentScaled * currentAvgCost.amountMinor : 0n;
  const incomingValue = incomingScaled * incomingCost.amountMinor;
  return money(divideRound(currentValue + incomingValue, totalScaled, mode), incomingCost.currency);
}
