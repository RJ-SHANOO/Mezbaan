import { Inject, Injectable } from "@nestjs/common";
import { add, calculateExclusiveTax, calculateInclusiveTax, calculateServiceCharge, money, type Money } from "@mezbaan/domain";
import { ServiceChargeSettingsService } from "./service-charge-settings.service.js";
import { TaxRulesService, type AppliedTaxRule } from "./tax-rules.service.js";
import { TaxSettingsService, type PricingMode } from "./tax-settings.service.js";
import type { OrderType } from "./price-lists.service.js";

export interface PreviewChargesParams {
  restaurantId: string;
  branchId: string;
  orderType: OrderType;
  subtotalMinor: bigint;
  currency: string;
}

export interface PreviewedChargesRecord {
  pricingMode: PricingMode;
  appliedTaxRules: AppliedTaxRule[];
  taxRateBasisPoints: number;
  serviceChargeRateBasisPoints: number | null;
  serviceChargeIsTaxable: boolean | null;
  subtotal: Money;
  serviceCharge: Money;
  taxBase: Money;
  tax: Money;
  total: Money;
}

/**
 * Composes the configured rules (TaxRulesService, TaxSettingsService,
 * ServiceChargeSettingsService — all P2-05) with packages/domain's pure,
 * terminal-and-server-shared calculation functions (P1-07) for one subtotal.
 * This is a preview only — it mutates nothing and isn't itself a financial
 * record; P2-18 (invoice generation) is the real consumer that will persist
 * a result like this against an actual sale.
 *
 * Documented convention, since the task gives no invoice flow yet to derive
 * this from: a service charge is always computed on the bare subtotal (never
 * on a tax-adjusted amount) and always added on top as its own line. Its
 * `isTaxable` flag only has an effect in **exclusive** pricing mode, where it
 * decides whether the service-charge amount is folded into the tax base
 * before tax is computed. In **inclusive** mode the configured tax rate is
 * assumed to already be baked into the subtotal (back out via
 * calculateInclusiveTax), so there is nothing left to tax the service charge
 * against — `isTaxable` is accepted but has no effect there, same as it has
 * no effect when no service charge is configured at all. P2-18 can revisit
 * this once a real order flow exists to validate the convention against.
 */
@Injectable()
export class TaxCalculationService {
  constructor(
    @Inject(TaxRulesService) private readonly taxRulesService: TaxRulesService,
    @Inject(TaxSettingsService) private readonly taxSettingsService: TaxSettingsService,
    @Inject(ServiceChargeSettingsService) private readonly serviceChargeSettingsService: ServiceChargeSettingsService,
  ) {}

  async previewCharges(params: PreviewChargesParams): Promise<PreviewedChargesRecord> {
    const subtotal = money(params.subtotalMinor, params.currency);

    const [pricingMode, appliedTaxRules, serviceChargeSetting] = await Promise.all([
      this.taxSettingsService.resolvePricingMode(params.restaurantId, params.branchId),
      this.taxRulesService.resolveApplicable({ restaurantId: params.restaurantId, branchId: params.branchId, orderType: params.orderType }),
      this.serviceChargeSettingsService.resolveApplicable({ restaurantId: params.restaurantId, branchId: params.branchId, orderType: params.orderType }),
    ]);

    const taxRateBasisPoints = appliedTaxRules.reduce((sum, rule) => sum + rule.rateBasisPoints, 0);
    const serviceCharge = serviceChargeSetting ? calculateServiceCharge(subtotal, serviceChargeSetting.rateBasisPoints) : money(0n, params.currency);

    if (pricingMode === "inclusive") {
      const breakdown = calculateInclusiveTax(subtotal, taxRateBasisPoints);
      return {
        pricingMode,
        appliedTaxRules,
        taxRateBasisPoints,
        serviceChargeRateBasisPoints: serviceChargeSetting?.rateBasisPoints ?? null,
        serviceChargeIsTaxable: serviceChargeSetting?.isTaxable ?? null,
        subtotal,
        serviceCharge,
        taxBase: breakdown.base,
        tax: breakdown.tax,
        total: add(breakdown.total, serviceCharge),
      };
    }

    const taxableBase = serviceChargeSetting?.isTaxable ? add(subtotal, serviceCharge) : subtotal;
    const breakdown = calculateExclusiveTax(taxableBase, taxRateBasisPoints);
    const total = serviceChargeSetting?.isTaxable ? breakdown.total : add(breakdown.total, serviceCharge);

    return {
      pricingMode,
      appliedTaxRules,
      taxRateBasisPoints,
      serviceChargeRateBasisPoints: serviceChargeSetting?.rateBasisPoints ?? null,
      serviceChargeIsTaxable: serviceChargeSetting?.isTaxable ?? null,
      subtotal,
      serviceCharge,
      taxBase: breakdown.base,
      tax: breakdown.tax,
      total,
    };
  }
}
