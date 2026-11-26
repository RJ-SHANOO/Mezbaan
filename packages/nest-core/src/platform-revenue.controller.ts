import { Controller, ForbiddenException, Get, Query, UnauthorizedException } from "@nestjs/common";
import { PlatformRevenueQuerySchema, type PlatformRevenue } from "@mezbaan/contracts";
import { PlatformRevenueService } from "./platform-revenue.service.js";
import { getTenantContext } from "./tenant-context.js";
import { parseOrBadRequest } from "./validation.js";

/** P3-39: the platform's own revenue across every restaurant —
 * super-admin-only, same split as every other platform-level controller
 * in this codebase. `from`/`to` are both optional; omitting either (or
 * both) means "unbounded in that direction", not "today" — there is no
 * implicit date default the way the per-branch business-day reports have
 * one, since this has no branch/timezone to anchor a default to. */
@Controller("platform")
export class PlatformRevenueController {
  constructor(private readonly platformRevenueService: PlatformRevenueService) {}

  @Get("revenue")
  async getRevenue(@Query() query: unknown): Promise<PlatformRevenue> {
    requireSuperAdmin();
    const { from, to } = parseOrBadRequest(PlatformRevenueQuerySchema, query);
    const byCurrency = await this.platformRevenueService.getRevenue({
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
    return {
      from: from ?? null,
      to: to ?? null,
      byCurrency: byCurrency.map((entry) => ({ currency: entry.currency, totalAmountMinor: entry.totalAmountMinor.toString() })),
    };
  }
}

function requireSuperAdmin(): void {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  if (!tenant.isSuperAdmin) {
    throw new ForbiddenException("Super admin access required");
  }
}
