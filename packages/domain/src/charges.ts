import { add, money, type Money } from "./money.js";
import { calculateExclusiveTax, calculateInclusiveTax } from "./tax.js";
import { calculateServiceCharge } from "./service-charge.js";
import type { RoundingMode } from "./rounding.js";

export type PricingMode = "inclusive" | "exclusive";

export interface AppliedTaxRule {
  name: string;
  rateBasisPoints: number;
}

export interface ChargesConfig {
  pricingMode: PricingMode;
  /** Already summed across every stacked rule — see TaxRulesService.resolveApplicable
   * (server) for how this is resolved; this function only consumes the result. */
  taxRateBasisPoints: number;
  serviceChargeRateBasisPoints: number | null;
  /** Only has an effect in exclusive pricing mode — see computeCharges' own docs. */
  serviceChargeIsTaxable: boolean | null;
}

export interface ChargesResult {
  subtotal: Money;
  serviceCharge: Money;
  taxBase: Money;
  tax: Money;
  total: Money;
}

/**
 * P2-45: extracted from what was TaxCalculationService.previewCharges' (server)
 * inline logic, so the offline terminal can compute the exact same charges from
 * the exact same code — not a second implementation that happens to match today.
 * `config` is always resolved server-side (TaxRulesService/TaxSettingsService/
 * ServiceChargeSettingsService) and synced down already-resolved (P1-27's
 * snapshot), the same "resolve once, sync the result" pattern P2-11 already uses
 * for prices — this function only ever does the pure arithmetic over whatever
 * config it's handed, online or offline.
 *
 * Documented convention (unchanged from previewCharges): a service charge is
 * always computed on the bare subtotal and added on top as its own line.
 * `serviceChargeIsTaxable` only has an effect in **exclusive** pricing mode,
 * where it decides whether the service-charge amount is folded into the tax
 * base before tax is computed. In **inclusive** mode the configured tax rate
 * is assumed to already be baked into the subtotal, so there's nothing left
 * to tax the service charge against.
 */
export function computeCharges(subtotal: Money, config: ChargesConfig, mode: RoundingMode = "HALF_UP"): ChargesResult {
  const serviceCharge = config.serviceChargeRateBasisPoints !== null ? calculateServiceCharge(subtotal, config.serviceChargeRateBasisPoints, mode) : money(0n, subtotal.currency);

  if (config.pricingMode === "inclusive") {
    const breakdown = calculateInclusiveTax(subtotal, config.taxRateBasisPoints, mode);
    return { subtotal, serviceCharge, taxBase: breakdown.base, tax: breakdown.tax, total: add(breakdown.total, serviceCharge) };
  }

  const taxableBase = config.serviceChargeIsTaxable ? add(subtotal, serviceCharge) : subtotal;
  const breakdown = calculateExclusiveTax(taxableBase, config.taxRateBasisPoints, mode);
  const total = config.serviceChargeIsTaxable ? breakdown.total : add(breakdown.total, serviceCharge);
  return { subtotal, serviceCharge, taxBase: breakdown.base, tax: breakdown.tax, total };
}
