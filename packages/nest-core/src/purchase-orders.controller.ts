import { Body, Controller, Get, Param, Post, Query, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import {
  ApprovePurchaseOrderSchema,
  CreatePurchaseOrderSchema,
  ListPurchaseOrdersQuerySchema,
  ReplacePurchaseOrderItemsSchema,
  type PurchaseOrder,
  type PurchaseOrderSummaryPage,
} from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { PurchaseOrdersService, type PurchaseOrderRecord } from "./purchase-orders.service.js";
import { parseOrBadRequest } from "./validation.js";

const PurchaseOrderIdParamSchema = z.object({ id: z.string().uuid() });

function toPurchaseOrderResponse(po: PurchaseOrderRecord): PurchaseOrder {
  return {
    id: po.id,
    branchId: po.branchId,
    supplierId: po.supplierId,
    status: po.status,
    currency: po.currency,
    note: po.note,
    createdByUserId: po.createdByUserId,
    approvedByUserId: po.approvedByUserId,
    approvedAt: po.approvedAt?.toISOString() ?? null,
    sentAt: po.sentAt?.toISOString() ?? null,
    closedAt: po.closedAt?.toISOString() ?? null,
    items: po.items.map((item) => ({
      id: item.id,
      itemId: item.itemId,
      quantity: item.quantity,
      unitId: item.unitId,
      unitCostMinor: item.unitCostMinor.toString(),
      currency: item.currency,
      receivedQuantity: item.receivedQuantity,
    })),
    createdAt: po.createdAt.toISOString(),
    updatedAt: po.updatedAt.toISOString(),
  };
}

@Controller("purchase-orders")
export class PurchaseOrdersController {
  constructor(private readonly purchaseOrdersService: PurchaseOrdersService) {}

  @Get()
  @RequirePermission("purchasing.manage")
  async list(@Query() query: unknown): Promise<PurchaseOrderSummaryPage> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ListPurchaseOrdersQuerySchema, query);
    const page = await this.purchaseOrdersService.list({ restaurantId: tenant.restaurantId, ...request });
    return { items: page.items.map((po) => toPurchaseOrderResponse({ ...po, items: [] })), nextCursor: page.nextCursor };
  }

  @Get(":id")
  @RequirePermission("purchasing.manage")
  async get(@Param() params: unknown): Promise<PurchaseOrder> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(PurchaseOrderIdParamSchema, params);
    const po = await this.purchaseOrdersService.get({ restaurantId: tenant.restaurantId, purchaseOrderId: id });
    return toPurchaseOrderResponse(po);
  }

  @Post()
  @RequirePermission("purchasing.manage")
  async create(@Body() body: unknown): Promise<PurchaseOrder> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(CreatePurchaseOrderSchema, body);
    const po = await this.purchaseOrdersService.create({
      ...request,
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.userId,
      items: request.items.map((item) => ({ ...item, unitCostMinor: BigInt(item.unitCostMinor) })),
    });
    return toPurchaseOrderResponse(po);
  }

  @Post(":id/items")
  @RequirePermission("purchasing.manage")
  async replaceItems(@Param() params: unknown, @Body() body: unknown): Promise<PurchaseOrder> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(PurchaseOrderIdParamSchema, params);
    const request = parseOrBadRequest(ReplacePurchaseOrderItemsSchema, body);
    const po = await this.purchaseOrdersService.replaceItems({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.userId,
      purchaseOrderId: id,
      items: request.items.map((item) => ({ ...item, unitCostMinor: BigInt(item.unitCostMinor) })),
    });
    return toPurchaseOrderResponse(po);
  }

  @Post(":id/approve")
  @RequirePermission("purchasing.manage")
  async approve(@Param() params: unknown, @Body() body: unknown): Promise<PurchaseOrder> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(PurchaseOrderIdParamSchema, params);
    const request = parseOrBadRequest(ApprovePurchaseOrderSchema, body);
    const po = await this.purchaseOrdersService.approve({ restaurantId: tenant.restaurantId, actorUserId: tenant.userId, purchaseOrderId: id, ...request });
    return toPurchaseOrderResponse(po);
  }

  @Post(":id/send")
  @RequirePermission("purchasing.manage")
  async markSent(@Param() params: unknown): Promise<PurchaseOrder> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(PurchaseOrderIdParamSchema, params);
    const po = await this.purchaseOrdersService.markSent({ restaurantId: tenant.restaurantId, actorUserId: tenant.userId, purchaseOrderId: id });
    return toPurchaseOrderResponse(po);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
