import { Body, Controller, Get, Param, Post, Query, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { CancelOrderSchema, CreateOrderSchema, ListOrdersQuerySchema, type Order } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { OrdersService, type OrderRecord } from "./orders.service.js";
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
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    closedAt: order.closedAt?.toISOString() ?? null,
  };
}

@Controller("orders")
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @RequirePermission("pos.sell")
  async list(@Query() query: unknown): Promise<Order[]> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ListOrdersQuerySchema, query);
    const orders = await this.ordersService.list({ restaurantId: tenant.restaurantId, branchId: request.branchId, status: request.status });
    return orders.map(toOrderResponse);
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
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
