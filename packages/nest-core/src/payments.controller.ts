import { Body, Controller, Get, Param, Post, Query, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { RecordPaymentSchema, type EqualSplit, type InvoiceBalance, type Payment } from "@mezbaan/contracts";
import type { Money } from "@mezbaan/domain";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { PaymentsService, type InvoiceBalance as InvoiceBalanceRecord, type PaymentRecord } from "./payments.service.js";
import { parseOrBadRequest } from "./validation.js";

const InvoiceIdParamSchema = z.object({ invoiceId: z.string().uuid() });

function toPaymentResponse(payment: PaymentRecord): Payment {
  return {
    id: payment.id,
    invoiceId: payment.invoiceId,
    method: payment.method,
    amountMinor: payment.amountMinor.toString(),
    tipMinor: payment.tipMinor.toString(),
    changeMinor: payment.changeMinor.toString(),
    currency: payment.currency,
    actorUserId: payment.actorUserId,
    createdAt: payment.createdAt.toISOString(),
  };
}

function toBalanceResponse(balance: InvoiceBalanceRecord): InvoiceBalance {
  return {
    totalMinor: balance.totalMinor.toString(),
    paidMinor: balance.paidMinor.toString(),
    remainingMinor: balance.remainingMinor.toString(),
  };
}

function toEqualSplitResponse(shares: Money[]): EqualSplit {
  // suggestEqualSplit always validates parts >= 1, so shares is never empty.
  return {
    currency: shares[0]!.currency,
    amountsMinor: shares.map((share) => share.amountMinor.toString()),
  };
}

@Controller("invoices/:invoiceId/payments")
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get()
  @RequirePermission("pos.sell")
  async list(@Param() params: unknown): Promise<Payment[]> {
    const tenant = requireTenant();
    const { invoiceId } = parseOrBadRequest(InvoiceIdParamSchema, params);
    const payments = await this.paymentsService.listForInvoice({ restaurantId: tenant.restaurantId, invoiceId });
    return payments.map(toPaymentResponse);
  }

  @Post()
  @RequirePermission("pos.sell")
  async record(@Param() params: unknown, @Body() body: unknown): Promise<Payment> {
    const tenant = requireTenant();
    const { invoiceId } = parseOrBadRequest(InvoiceIdParamSchema, params);
    const request = parseOrBadRequest(RecordPaymentSchema, body);
    const payment = await this.paymentsService.record({
      restaurantId: tenant.restaurantId,
      invoiceId,
      actorUserId: tenant.userId,
      method: request.method,
      amountMinor: BigInt(request.amountMinor),
      tipMinor: request.tipMinor !== undefined ? BigInt(request.tipMinor) : undefined,
      tenderedMinor: request.tenderedMinor !== undefined ? BigInt(request.tenderedMinor) : undefined,
    });
    return toPaymentResponse(payment);
  }
}

/** P2-20: a separate top-level resource from /payments — the balance is a
 * derived view over the invoice + its payments together, not a payment
 * itself, so it doesn't belong under either one's own collection route. */
@Controller("invoices/:invoiceId/balance")
export class InvoiceBalanceController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get()
  @RequirePermission("pos.sell")
  async get(@Param() params: unknown): Promise<InvoiceBalance> {
    const tenant = requireTenant();
    const { invoiceId } = parseOrBadRequest(InvoiceIdParamSchema, params);
    const balance = await this.paymentsService.getBalance({ restaurantId: tenant.restaurantId, invoiceId });
    return toBalanceResponse(balance);
  }
}

const SplitQuerySchema = z.object({ parts: z.coerce.number().int().positive() });

/** P2-21: "split into equal parts" — a suggestion only (see PaymentsService.suggestEqualSplit);
 * a separate top-level resource for the same reason InvoiceBalanceController is. */
@Controller("invoices/:invoiceId/split")
export class InvoiceSplitController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get()
  @RequirePermission("pos.sell")
  async get(@Param() params: unknown, @Query() query: unknown): Promise<EqualSplit> {
    const tenant = requireTenant();
    const { invoiceId } = parseOrBadRequest(InvoiceIdParamSchema, params);
    const { parts } = parseOrBadRequest(SplitQuerySchema, query);
    const shares = await this.paymentsService.suggestEqualSplit({ restaurantId: tenant.restaurantId, invoiceId, parts });
    return toEqualSplitResponse(shares);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
