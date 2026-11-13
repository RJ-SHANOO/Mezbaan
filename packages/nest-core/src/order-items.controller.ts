import { Body, Controller, Delete, Get, Param, Patch, Post, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { AddOrderItemSchema, FireOrderItemsSchema, UpdateOrderItemSchema, type OrderItem } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { OrderItemsService, type OrderItemRecord } from "./order-items.service.js";
import { parseOrBadRequest } from "./validation.js";

const OrderIdParamSchema = z.object({ orderId: z.string().uuid() });
const ItemIdParamSchema = z.object({ orderId: z.string().uuid(), itemId: z.string().uuid() });

export function toItemResponse(item: OrderItemRecord): OrderItem {
  return {
    id: item.id,
    orderId: item.orderId,
    productId: item.productId,
    variantId: item.variantId,
    quantity: item.quantity,
    unitPriceMinor: item.unitPriceMinor.toString(),
    currency: item.currency,
    priceListId: item.priceListId,
    priceListVersion: item.priceListVersion,
    notes: item.notes,
    seatNumber: item.seatNumber,
    course: item.course,
    firedAt: item.firedAt?.toISOString() ?? null,
    firedByUserId: item.firedByUserId,
    modifiers: item.modifiers.map((m) => ({
      id: m.id,
      modifierOptionId: m.modifierOptionId,
      quantity: m.quantity,
      unitPriceMinor: m.unitPriceMinor.toString(),
      currency: m.currency,
    })),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

@Controller("orders/:orderId/items")
export class OrderItemsController {
  constructor(private readonly orderItemsService: OrderItemsService) {}

  @Get()
  @RequirePermission("pos.sell")
  async list(@Param() params: unknown): Promise<OrderItem[]> {
    const tenant = requireTenant();
    const { orderId } = parseOrBadRequest(OrderIdParamSchema, params);
    const items = await this.orderItemsService.list(tenant.restaurantId, orderId);
    return items.map(toItemResponse);
  }

  @Post()
  @RequirePermission("pos.sell")
  async addItem(@Param() params: unknown, @Body() body: unknown): Promise<OrderItem> {
    const tenant = requireTenant();
    const { orderId } = parseOrBadRequest(OrderIdParamSchema, params);
    const request = parseOrBadRequest(AddOrderItemSchema, body);
    const item = await this.orderItemsService.addItem({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId, orderId });
    return toItemResponse(item);
  }

  /** P2-15: fire either a named set of items, or every un-fired item of a course, to the kitchen. */
  @Post("fire")
  @RequirePermission("pos.sell")
  async fire(@Param() params: unknown, @Body() body: unknown): Promise<OrderItem[]> {
    const tenant = requireTenant();
    const { orderId } = parseOrBadRequest(OrderIdParamSchema, params);
    const request = parseOrBadRequest(FireOrderItemsSchema, body);
    const items = await this.orderItemsService.fireItems({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.userId,
      orderId,
      itemIds: request.itemIds,
      course: request.course,
    });
    return items.map(toItemResponse);
  }

  @Patch(":itemId")
  @RequirePermission("pos.sell")
  async updateItem(@Param() params: unknown, @Body() body: unknown): Promise<OrderItem> {
    const tenant = requireTenant();
    const { orderId, itemId } = parseOrBadRequest(ItemIdParamSchema, params);
    const request = parseOrBadRequest(UpdateOrderItemSchema, body);
    const item = await this.orderItemsService.updateItem({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId, orderId, itemId });
    return toItemResponse(item);
  }

  @Delete(":itemId")
  @RequirePermission("pos.sell")
  async removeItem(@Param() params: unknown): Promise<{ removed: true }> {
    const tenant = requireTenant();
    const { orderId, itemId } = parseOrBadRequest(ItemIdParamSchema, params);
    await this.orderItemsService.removeItem({ restaurantId: tenant.restaurantId, actorUserId: tenant.userId, orderId, itemId });
    return { removed: true };
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
