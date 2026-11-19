import { Controller, Get, Query, UnauthorizedException } from "@nestjs/common";
import { ListReconciliationFlagsQuerySchema, type ReconciliationFlagPage } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { ReconciliationService } from "./reconciliation.service.js";
import { parseOrBadRequest } from "./validation.js";

/** P2-26: read side of the reconciliation review queue — same reports.view
 * permission and api-reports home as P2-40's sales reports (rule: "api-reports
 * fails → selling and stock continue; reports are delayed"), since a review
 * queue is a reporting concern, not something that needs to block a sale. */
@Controller("reconciliation-flags")
export class ReconciliationFlagsController {
  constructor(private readonly reconciliationService: ReconciliationService) {}

  @Get()
  @RequirePermission("reports.view")
  async list(@Query() query: unknown): Promise<ReconciliationFlagPage> {
    const tenant = requireTenant();
    const { branchId, limit, cursor } = parseOrBadRequest(ListReconciliationFlagsQuerySchema, query);
    const page = await this.reconciliationService.listFlags({ restaurantId: tenant.restaurantId, branchId, limit, cursor });
    return {
      items: page.items.map((flag) => ({
        id: flag.id,
        branchId: flag.branchId,
        invoiceId: flag.invoiceId,
        orderId: flag.orderId,
        storedSubtotalMinor: flag.storedSubtotalMinor.toString(),
        expectedSubtotalMinor: flag.expectedSubtotalMinor.toString(),
        storedServiceChargeMinor: flag.storedServiceChargeMinor.toString(),
        expectedServiceChargeMinor: flag.expectedServiceChargeMinor.toString(),
        storedTaxMinor: flag.storedTaxMinor.toString(),
        expectedTaxMinor: flag.expectedTaxMinor.toString(),
        storedTotalMinor: flag.storedTotalMinor.toString(),
        expectedTotalMinor: flag.expectedTotalMinor.toString(),
        mismatchedFields: flag.mismatchedFields.split(","),
        reviewedAt: flag.reviewedAt ? flag.reviewedAt.toISOString() : null,
        createdAt: flag.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
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
