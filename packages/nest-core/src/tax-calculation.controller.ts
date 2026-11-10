import { Controller, Get, Query, UnauthorizedException } from "@nestjs/common";
import { PreviewChargesQuerySchema, type PreviewedCharges } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { TaxCalculationService } from "./tax-calculation.service.js";
import { parseOrBadRequest } from "./validation.js";

@Controller("tax")
export class TaxCalculationController {
  constructor(private readonly taxCalculationService: TaxCalculationService) {}

  @Get("preview")
  @RequirePermission("menu.manage")
  async preview(@Query() query: unknown): Promise<PreviewedCharges> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(PreviewChargesQuerySchema, query);
    const result = await this.taxCalculationService.previewCharges({
      restaurantId: tenant.restaurantId,
      branchId: request.branchId,
      orderType: request.orderType,
      subtotalMinor: BigInt(request.subtotalMinor),
      currency: request.currency,
    });
    return {
      pricingMode: result.pricingMode,
      appliedTaxRules: result.appliedTaxRules,
      taxRateBasisPoints: result.taxRateBasisPoints,
      serviceChargeRateBasisPoints: result.serviceChargeRateBasisPoints,
      serviceChargeIsTaxable: result.serviceChargeIsTaxable,
      subtotalMinor: result.subtotal.amountMinor.toString(),
      serviceChargeMinor: result.serviceCharge.amountMinor.toString(),
      taxBaseMinor: result.taxBase.amountMinor.toString(),
      taxMinor: result.tax.amountMinor.toString(),
      totalMinor: result.total.amountMinor.toString(),
    };
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
