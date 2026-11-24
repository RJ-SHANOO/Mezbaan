import { Body, Controller, Get, Param, Post, Put, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { IssueRefundSchema, SetRefundReasonCodeSchema, type Refund, type RefundBalance, type RefundReasonCode } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { RefundsService, type RefundBalance as RefundBalanceRecord, type RefundReasonCodeRecord, type RefundRecord } from "./refunds.service.js";
import { parseOrBadRequest } from "./validation.js";

const InvoiceIdParamSchema = z.object({ invoiceId: z.string().uuid() });

function toReasonCodeResponse(row: RefundReasonCodeRecord): RefundReasonCode {
  return { id: row.id, code: row.code, label: row.label, isActive: row.isActive, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

function toBalanceResponse(balance: RefundBalanceRecord): RefundBalance {
  return { paidMinor: balance.paidMinor.toString(), refundedMinor: balance.refundedMinor.toString(), refundableMinor: balance.refundableMinor.toString() };
}

function toRefundResponse(refund: RefundRecord): Refund {
  return {
    id: refund.id,
    invoiceId: refund.invoiceId,
    amountMinor: refund.amountMinor.toString(),
    currency: refund.currency,
    reasonCode: refund.reasonCode,
    actorUserId: refund.actorUserId,
    approvedByUserId: refund.approvedByUserId,
    createdAt: refund.createdAt.toISOString(),
  };
}

/** P2-24, admin side: the restaurant-defined refund reason codes — same
 * menu.manage tier as void/discount reason codes, lives in CatalogModule
 * for api-admin. No limits table, same reasoning as RefundsService: a
 * refund always needs manager approval, there's no own-authority tier to
 * configure a threshold for. */
@Controller("refund-reason-codes")
export class RefundReasonCodesController {
  constructor(private readonly refundsService: RefundsService) {}

  @Get()
  @RequirePermission("menu.manage")
  async list(): Promise<RefundReasonCode[]> {
    const tenant = requireTenant();
    const codes = await this.refundsService.listReasonCodes(tenant.restaurantId);
    return codes.map(toReasonCodeResponse);
  }

  @Put()
  @RequirePermission("menu.manage")
  async set(@Body() body: unknown): Promise<RefundReasonCode> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(SetRefundReasonCodeSchema, body);
    const code = await this.refundsService.setReasonCode({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toReasonCodeResponse(code);
  }
}

/** P2-24, POS side: issuing a refund is gated by pos.sell like any other
 * billing action — the manager-PIN approval itself happens inside
 * RefundsService (ManagerPinService checks billing.refund.approve), not via
 * a different route permission. */
@Controller("invoices/:invoiceId/refunds")
export class InvoiceRefundsController {
  constructor(private readonly refundsService: RefundsService) {}

  @Get()
  @RequirePermission("pos.sell")
  async list(@Param() params: unknown): Promise<Refund[]> {
    const tenant = requireTenant();
    const { invoiceId } = parseOrBadRequest(InvoiceIdParamSchema, params);
    const refunds = await this.refundsService.listForInvoice({ restaurantId: tenant.restaurantId, invoiceId });
    return refunds.map(toRefundResponse);
  }

  @Post()
  @RequirePermission("pos.sell")
  async issue(@Param() params: unknown, @Body() body: unknown): Promise<Refund> {
    const tenant = requireTenant();
    const { invoiceId } = parseOrBadRequest(InvoiceIdParamSchema, params);
    const request = parseOrBadRequest(IssueRefundSchema, body);
    const refund = await this.refundsService.issue({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.userId,
      invoiceId,
      amountMinor: BigInt(request.amountMinor),
      reasonCode: request.reasonCode,
      managerUserId: request.managerUserId,
      managerPin: request.managerPin,
      itemIds: request.itemIds,
      stockDisposition: request.stockDisposition,
    });
    return toRefundResponse(refund);
  }
}

@Controller("invoices/:invoiceId/refund-balance")
export class InvoiceRefundBalanceController {
  constructor(private readonly refundsService: RefundsService) {}

  @Get()
  @RequirePermission("pos.sell")
  async get(@Param() params: unknown): Promise<RefundBalance> {
    const tenant = requireTenant();
    const { invoiceId } = parseOrBadRequest(InvoiceIdParamSchema, params);
    const balance = await this.refundsService.getBalance({ restaurantId: tenant.restaurantId, invoiceId });
    return toBalanceResponse(balance);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
