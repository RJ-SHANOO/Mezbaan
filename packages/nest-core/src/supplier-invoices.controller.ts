import { Body, Controller, Get, Param, Post, Query, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import {
  ListSupplierInvoiceMatchFlagsQuerySchema,
  RecordSupplierInvoiceSchema,
  type RecordSupplierInvoiceResult,
  type SupplierInvoice,
  type SupplierInvoiceMatchFlagPage,
} from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import {
  SupplierInvoicesService,
  type SupplierInvoiceMatchFlagRecord,
  type SupplierInvoiceRecord,
} from "./supplier-invoices.service.js";
import { parseOrBadRequest } from "./validation.js";

const SupplierInvoiceIdParamSchema = z.object({ id: z.string().uuid() });
const PurchaseOrderIdParamSchema = z.object({ purchaseOrderId: z.string().uuid() });
const FlagIdParamSchema = z.object({ id: z.string().uuid() });

function toInvoiceResponse(invoice: SupplierInvoiceRecord): SupplierInvoice {
  return {
    id: invoice.id,
    branchId: invoice.branchId,
    purchaseOrderId: invoice.purchaseOrderId,
    supplierId: invoice.supplierId,
    supplierInvoiceNumber: invoice.supplierInvoiceNumber,
    currency: invoice.currency,
    totalMinor: invoice.totalMinor.toString(),
    recordedByUserId: invoice.recordedByUserId,
    items: invoice.items.map((item) => ({
      id: item.id,
      purchaseOrderItemId: item.purchaseOrderItemId,
      itemId: item.itemId,
      quantity: item.quantity,
      unitCostMinor: item.unitCostMinor.toString(),
      currency: item.currency,
    })),
    createdAt: invoice.createdAt.toISOString(),
  };
}

function toFlagResponse(flag: SupplierInvoiceMatchFlagRecord) {
  return {
    id: flag.id,
    branchId: flag.branchId,
    supplierInvoiceId: flag.supplierInvoiceId,
    supplierInvoiceItemId: flag.supplierInvoiceItemId,
    purchaseOrderItemId: flag.purchaseOrderItemId,
    invoicedQuantity: flag.invoicedQuantity,
    orderedQuantity: flag.orderedQuantity,
    receivedQuantity: flag.receivedQuantity,
    invoicedUnitCostMinor: flag.invoicedUnitCostMinor.toString(),
    orderedUnitCostMinor: flag.orderedUnitCostMinor.toString(),
    currency: flag.currency,
    mismatchedFields: flag.mismatchedFields,
    reviewedAt: flag.reviewedAt?.toISOString() ?? null,
    reviewedByUserId: flag.reviewedByUserId,
    createdAt: flag.createdAt.toISOString(),
  };
}

@Controller("supplier-invoices")
export class SupplierInvoicesController {
  constructor(private readonly supplierInvoicesService: SupplierInvoicesService) {}

  @Get(":id")
  @RequirePermission("purchasing.manage")
  async get(@Param() params: unknown): Promise<SupplierInvoice> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(SupplierInvoiceIdParamSchema, params);
    const invoice = await this.supplierInvoicesService.get({ restaurantId: tenant.restaurantId, supplierInvoiceId: id });
    return toInvoiceResponse(invoice);
  }

  @Post()
  @RequirePermission("purchasing.receive")
  async record(@Body() body: unknown): Promise<RecordSupplierInvoiceResult> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(RecordSupplierInvoiceSchema, body);
    const result = await this.supplierInvoicesService.record({
      ...request,
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.userId,
      totalMinor: BigInt(request.totalMinor),
      items: request.items.map((item) => ({ ...item, unitCostMinor: BigInt(item.unitCostMinor) })),
    });
    return { invoice: toInvoiceResponse(result.invoice), flags: result.flags.map(toFlagResponse) };
  }
}

@Controller("purchase-orders/:purchaseOrderId/supplier-invoices")
export class PurchaseOrderSupplierInvoicesController {
  constructor(private readonly supplierInvoicesService: SupplierInvoicesService) {}

  @Get()
  @RequirePermission("purchasing.manage")
  async list(@Param() params: unknown): Promise<SupplierInvoice[]> {
    const tenant = requireTenant();
    const { purchaseOrderId } = parseOrBadRequest(PurchaseOrderIdParamSchema, params);
    const invoices = await this.supplierInvoicesService.listForPurchaseOrder({ restaurantId: tenant.restaurantId, purchaseOrderId });
    return invoices.map(toInvoiceResponse);
  }
}

@Controller("supplier-invoice-match-flags")
export class SupplierInvoiceMatchFlagsController {
  constructor(private readonly supplierInvoicesService: SupplierInvoicesService) {}

  @Get()
  @RequirePermission("purchasing.manage")
  async list(@Query() query: unknown): Promise<SupplierInvoiceMatchFlagPage> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ListSupplierInvoiceMatchFlagsQuerySchema, query);
    const page = await this.supplierInvoicesService.listFlags({ restaurantId: tenant.restaurantId, ...request });
    return { items: page.items.map(toFlagResponse), nextCursor: page.nextCursor };
  }

  @Post(":id/review")
  @RequirePermission("purchasing.manage")
  async review(@Param() params: unknown) {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(FlagIdParamSchema, params);
    const flag = await this.supplierInvoicesService.reviewFlag({ restaurantId: tenant.restaurantId, actorUserId: tenant.userId, flagId: id });
    return toFlagResponse(flag);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
