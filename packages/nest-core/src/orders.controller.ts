import { Body, Controller, Get, Param, Post, Query, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import {
  CancelOrderSchema,
  CreateOrderSchema,
  HoldOrderSchema,
  ListOrdersQuerySchema,
  MergeOrderSchema,
  SplitOrderSchema,
  TransferOrderSchema,
  type MergeOrderResult,
  type Order,
  type OrderPage,
  type OrderStatusHistoryEntry,
  type OrderTab,
  type SplitOrderResult,
} from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import {
  OrdersService,
  type MergeTablesResult,
  type OrderRecord,
  type OrderStatusHistoryEntry as OrderStatusHistoryRecord,
  type OrderTab as OrderTabRecord,
  type SplitTableResult,
} from "./orders.service.js";
import { toItemResponse } from "./order-items.controller.js";
import { parseOrBadRequest } from "./validation.js";

const OrderIdParamSchema = z.object({ id: z.string().uuid() });

function toOrderResponse(order: OrderRecord): Order {
  return {
    id: order.id,
    branchId: order.branchId,
    orderType: order.orderType,
    tableId: order.tableId,
    status: order.status,
    currency: order.currency,
    openedByUserId: order.openedByUserId,
    discountPercentBasisPoints: order.discountPercentBasisPoints,
    discountAmountMinor: order.discountAmountMinor?.toString() ?? null,
    discountReasonCode: order.discountReasonCode,
    discountApprovedByUserId: order.discountApprovedByUserId,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    closedAt: order.closedAt?.toISOString() ?? null,
  };
}

function toStatusHistoryResponse(entry: OrderStatusHistoryRecord): OrderStatusHistoryEntry {
  return {
    id: entry.id,
    orderId: entry.orderId,
    fromStatus: entry.fromStatus,
    toStatus: entry.toStatus,
    actorUserId: entry.actorUserId,
    reason: entry.reason,
    createdAt: entry.createdAt.toISOString(),
  };
}

function toTabResponse(tab: OrderTabRecord): OrderTab {
  return {
    tableId: tab.tableId,
    order: tab.order ? toOrderResponse(tab.order) : null,
    items: tab.items.map(toItemResponse),
    totalMinor: tab.total?.amountMinor.toString() ?? null,
    currency: tab.total?.currency ?? null,
  };
}

function toMergeResultResponse(result: MergeTablesResult): MergeOrderResult {
  return { targetOrder: toOrderResponse(result.targetOrder), sourceOrderId: result.sourceOrderId };
}

function toSplitResultResponse(result: SplitTableResult): SplitOrderResult {
  return { sourceOrder: toOrderResponse(result.sourceOrder), newOrder: toOrderResponse(result.newOrder) };
}

@Controller("orders")
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @RequirePermission("pos.sell")
  async list(@Query() query: unknown): Promise<OrderPage> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ListOrdersQuerySchema, query);
    const page = await this.ordersService.list({
      restaurantId: tenant.restaurantId,
      branchId: request.branchId,
      status: request.status,
      cursor: request.cursor,
      limit: request.limit,
    });
    return { items: page.items.map(toOrderResponse), nextCursor: page.nextCursor };
  }

  @Post()
  @RequirePermission("pos.sell")
  async create(@Body() body: unknown): Promise<Order> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(CreateOrderSchema, body);
    const order = await this.ordersService.create({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toOrderResponse(order);
  }

  @Post(":id/close")
  @RequirePermission("pos.sell")
  async close(@Param() params: unknown): Promise<Order> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(OrderIdParamSchema, params);
    const order = await this.ordersService.close({ restaurantId: tenant.restaurantId, orderId: id, actorUserId: tenant.userId });
    return toOrderResponse(order);
  }

  @Post(":id/cancel")
  @RequirePermission("pos.sell")
  async cancel(@Param() params: unknown, @Body() body: unknown): Promise<Order> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(OrderIdParamSchema, params);
    const request = parseOrBadRequest(CancelOrderSchema, body ?? {});
    const order = await this.ordersService.cancel({ restaurantId: tenant.restaurantId, orderId: id, actorUserId: tenant.userId, reason: request.reason });
    return toOrderResponse(order);
  }

  @Get(":id/status-history")
  @RequirePermission("pos.sell")
  async statusHistory(@Param() params: unknown): Promise<OrderStatusHistoryEntry[]> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(OrderIdParamSchema, params);
    const entries = await this.ordersService.getStatusHistory({ restaurantId: tenant.restaurantId, orderId: id });
    return entries.map(toStatusHistoryResponse);
  }

  @Post(":id/hold")
  @RequirePermission("pos.sell")
  async hold(@Param() params: unknown, @Body() body: unknown): Promise<Order> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(OrderIdParamSchema, params);
    const request = parseOrBadRequest(HoldOrderSchema, body ?? {});
    const order = await this.ordersService.hold({ restaurantId: tenant.restaurantId, orderId: id, actorUserId: tenant.userId, reason: request.reason });
    return toOrderResponse(order);
  }

  @Post(":id/recall")
  @RequirePermission("pos.sell")
  async recall(@Param() params: unknown): Promise<Order> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(OrderIdParamSchema, params);
    const order = await this.ordersService.recall({ restaurantId: tenant.restaurantId, orderId: id, actorUserId: tenant.userId });
    return toOrderResponse(order);
  }

  /** P2-08: move this dine-in order to a different, currently-free table. */
  @Post(":id/transfer")
  @RequirePermission("pos.sell")
  async transfer(@Param() params: unknown, @Body() body: unknown): Promise<Order> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(OrderIdParamSchema, params);
    const request = parseOrBadRequest(TransferOrderSchema, body);
    const order = await this.ordersService.transferTable({
      restaurantId: tenant.restaurantId,
      orderId: id,
      actorUserId: tenant.userId,
      targetTableId: request.targetTableId,
    });
    return toOrderResponse(order);
  }

  /** P2-08: merge this order's items into whichever order currently occupies the target table. */
  @Post(":id/merge")
  @RequirePermission("pos.sell")
  async merge(@Param() params: unknown, @Body() body: unknown): Promise<MergeOrderResult> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(OrderIdParamSchema, params);
    const request = parseOrBadRequest(MergeOrderSchema, body);
    const result = await this.ordersService.mergeTables({
      restaurantId: tenant.restaurantId,
      orderId: id,
      actorUserId: tenant.userId,
      targetTableId: request.targetTableId,
    });
    return toMergeResultResponse(result);
  }

  /** P2-08: split the given items off this order onto a new order at a different, currently-free table. */
  @Post(":id/split")
  @RequirePermission("pos.sell")
  async split(@Param() params: unknown, @Body() body: unknown): Promise<SplitOrderResult> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(OrderIdParamSchema, params);
    const request = parseOrBadRequest(SplitOrderSchema, body);
    const result = await this.ordersService.splitTable({
      restaurantId: tenant.restaurantId,
      orderId: id,
      actorUserId: tenant.userId,
      targetTableId: request.targetTableId,
      itemIds: request.itemIds,
    });
    return toSplitResultResponse(result);
  }
}

const TableIdParamSchema = z.object({ tableId: z.string().uuid() });

/** P2-14: the running tab for a dine-in table — whichever order currently occupies it, if any. */
@Controller("tables/:tableId/tab")
export class TableTabController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @RequirePermission("pos.sell")
  async getTab(@Param() params: unknown): Promise<OrderTab> {
    const tenant = requireTenant();
    const { tableId } = parseOrBadRequest(TableIdParamSchema, params);
    const tab = await this.ordersService.getTableTab({ restaurantId: tenant.restaurantId, tableId });
    return toTabResponse(tab);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
