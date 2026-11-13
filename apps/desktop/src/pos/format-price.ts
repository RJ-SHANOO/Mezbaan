import { money, toMajorUnits, type Money } from "@mezbaan/domain";

/** Display-only formatting through packages/domain (rule 5: money math, even
 * this trivial a sliver of it, never happens by hand on the frontend). */
export function formatPrice(unitPriceMinor: string | null, currency: string | null): string {
  if (unitPriceMinor === null || currency === null) return "No price set";
  return `${currency} ${toMajorUnits(money(BigInt(unitPriceMinor), currency))}`;
}

export function formatMoney(amount: Money): string {
  return `${amount.currency} ${toMajorUnits(amount)}`;
}
