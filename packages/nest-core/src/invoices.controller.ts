import { Body, Controller, Get, Param, Post, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { GenerateInvoiceSchema, SplitByItemsSchema, SplitBySeatSchema, type Invoice } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { InvoicesService, type InvoiceRecord } from "./invoices.service.js";
import { parseOrBadRequest } from "./validation.js";

const OrderIdParamSchema = z.object({ id: z.string().uuid() });

function toInvoiceResponse(invoice: InvoiceRecord): Invoice {
  return {
    id: invoice.id,
    orderId: invoice.orderId,
    deviceId: invoice.deviceId,
    documentNumber: invoice.documentNumber,
    subtotalMinor: invoice.subtotalMinor.toString(),
    serviceChargeMinor: invoice.serviceChargeMinor.toString(),
    taxMinor: invoice.taxMinor.toString(),
    totalMinor: invoice.totalMinor.toString(),
    currency: invoice.currency,
    pricingMode: invoice.pricingMode,
    taxRateBasisPoints: invoice.taxRateBasisPoints,
    serviceChargeRateBasisPoints: invoice.serviceChargeRateBasisPoints,
    appliedTaxRules: invoice.appliedTaxRules,
    actorUserId: invoice.actorUserId,
    createdAt: invoice.createdAt.toISOString(),
  };
}

@Controller("orders/:id/invoice")
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Post()
  @RequirePermission("pos.sell")
  async generate(@Param() params: unknown, @Body() body: unknown): Promise<Invoice> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(OrderIdParamSchema, params);
    const request = parseOrBadRequest(GenerateInvoiceSchema, body);
    const invoice = await this.invoicesService.generate({
      restaurantId: tenant.restaurantId,
      orderId: id,
      deviceId: request.deviceId,
      actorUserId: tenant.userId,
      itemIds: request.itemIds,
    });
    return toInvoiceResponse(invoice);
  }

  @Get()
  @RequirePermission("pos.sell")
  async getForOrder(@Param() params: unknown): Promise<Invoice | null> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(OrderIdParamSchema, params);
    const invoice = await this.invoicesService.getByOrderId({ restaurantId: tenant.restaurantId, orderId: id });
    return invoice ? toInvoiceResponse(invoice) : null;
  }
}

/** P2-21: once an order can carry more than one invoice (split by item/seat), "the"
 * invoice stops being a well-formed question — this is the real list, and the
 * singular GET above (unchanged for backward compatibility) just returns the first. */
@Controller("orders/:id/invoices")
export class InvoiceListController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Get()
  @RequirePermission("pos.sell")
  async list(@Param() params: unknown): Promise<Invoice[]> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(OrderIdParamSchema, params);
    const invoices = await this.invoicesService.listByOrderId({ restaurantId: tenant.restaurantId, orderId: id });
    return invoices.map(toInvoiceResponse);
  }

  @Post("split-by-seat")
  @RequirePermission("pos.sell")
  async splitBySeat(@Param() params: unknown, @Body() body: unknown): Promise<Invoice[]> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(OrderIdParamSchema, params);
    const request = parseOrBadRequest(SplitBySeatSchema, body);
    const invoices = await this.invoicesService.splitBySeat({
      restaurantId: tenant.restaurantId,
      orderId: id,
      deviceId: request.deviceId,
      actorUserId: tenant.userId,
    });
    return invoices.map(toInvoiceResponse);
  }

  @Post("split-by-items")
  @RequirePermission("pos.sell")
  async splitByItems(@Param() params: unknown, @Body() body: unknown): Promise<Invoice[]> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(OrderIdParamSchema, params);
    const request = parseOrBadRequest(SplitByItemsSchema, body);
    const invoices = await this.invoicesService.splitByItems({
      restaurantId: tenant.restaurantId,
      orderId: id,
      deviceId: request.deviceId,
      actorUserId: tenant.userId,
      groups: request.groups,
    });
    return invoices.map(toInvoiceResponse);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
