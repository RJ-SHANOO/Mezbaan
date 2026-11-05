import { money, type Money } from "./money.js";
import { divideRound, type RoundingMode } from "./rounding.js";

/** 1 basis point = 0.01%, so 10000 = 100%, 500 = 5%, 1650 = 16.5%. Keeps every rate an
 * exact integer — no float rate like 0.055 ever enters a money calculation. */
export const BASIS_POINTS_SCALE = 10_000n;

export function applyPercentage(
  amount: Money,
  rateBasisPoints: number | bigint,
  mode: RoundingMode = "HALF_UP",
): Money {
  const rate = typeof rateBasisPoints === "bigint" ? rateBasisPoints : BigInt(rateBasisPoints);
  const amountMinor = divideRound(amount.amountMinor * rate, BASIS_POINTS_SCALE, mode);
  return money(amountMinor, amount.currency);
}
