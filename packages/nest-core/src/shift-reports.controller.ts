import { Controller, Get, Param, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import type { XReport, ZReport } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { ShiftReportsService, type XReport as XReportRecord, type ZReport as ZReportRecord } from "./shift-reports.service.js";
import { parseOrBadRequest } from "./validation.js";

const ShiftIdParamSchema = z.object({ shiftId: z.string().uuid() });

function toXReportResponse(report: XReportRecord): XReport {
  return {
    shiftId: report.shiftId,
    openingFloatMinor: report.openingFloatMinor.toString(),
    asOf: report.asOf.toISOString(),
    salesByMethod: { cash: report.salesByMethod.cash.toString(), card: report.salesByMethod.card.toString(), bank_transfer: report.salesByMethod.bank_transfer.toString(), wallet: report.salesByMethod.wallet.toString() },
    cashSalesMinor: report.cashSalesMinor.toString(),
    cashInMinor: report.cashInMinor.toString(),
    cashOutMinor: report.cashOutMinor.toString(),
    expectedCashMinor: report.expectedCashMinor.toString(),
  };
}

function toZReportResponse(report: ZReportRecord): ZReport {
  return {
    shiftId: report.shiftId,
    openingFloatMinor: report.openingFloatMinor.toString(),
    closedAt: report.closedAt.toISOString(),
    salesByMethod: { cash: report.salesByMethod.cash.toString(), card: report.salesByMethod.card.toString(), bank_transfer: report.salesByMethod.bank_transfer.toString(), wallet: report.salesByMethod.wallet.toString() },
    cashSalesMinor: report.cashSalesMinor.toString(),
    cashInMinor: report.cashInMinor.toString(),
    cashOutMinor: report.cashOutMinor.toString(),
    expectedCashMinor: report.expectedCashMinor.toString(),
    countedCashMinor: report.countedCashMinor.toString(),
    overShortMinor: report.overShortMinor.toString(),
  };
}

/** P2-29: the X report (mid-shift snapshot, any time while a shift is open
 * or closed) and the Z report (end-of-shift, requires the shift to already
 * be closed and counted) — pos.sell-gated like the rest of the shift
 * endpoints, lives in api-pos's OrdersModule. */
@Controller("shifts/:shiftId")
export class ShiftReportsController {
  constructor(private readonly shiftReportsService: ShiftReportsService) {}

  @Get("x-report")
  @RequirePermission("pos.sell")
  async getXReport(@Param() params: unknown): Promise<XReport> {
    const tenant = requireTenant();
    const { shiftId } = parseOrBadRequest(ShiftIdParamSchema, params);
    const report = await this.shiftReportsService.getXReport({ restaurantId: tenant.restaurantId, shiftId });
    return toXReportResponse(report);
  }

  @Get("z-report")
  @RequirePermission("pos.sell")
  async getZReport(@Param() params: unknown): Promise<ZReport> {
    const tenant = requireTenant();
    const { shiftId } = parseOrBadRequest(ShiftIdParamSchema, params);
    const report = await this.shiftReportsService.getZReport({ restaurantId: tenant.restaurantId, shiftId });
    return toZReportResponse(report);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
