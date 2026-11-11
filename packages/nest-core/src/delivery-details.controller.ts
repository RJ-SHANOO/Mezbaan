import { Body, Controller, Get, Param, Patch, Put, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { AssignRiderSchema, SetDeliveryDetailsSchema, UpdateDeliveryStatusSchema, type DeliveryDetails } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { DeliveryDetailsService, type DeliveryDetailsRecord } from "./delivery-details.service.js";
import { parseOrBadRequest } from "./validation.js";

const OrderIdParamSchema = z.object({ orderId: z.string().uuid() });

function toDetailsResponse(details: DeliveryDetailsRecord): DeliveryDetails {
  return {
    id: details.id,
    orderId: details.orderId,
    customerName: details.customerName,
    customerPhone: details.customerPhone,
    addressLine1: details.addressLine1,
    addressLine2: details.addressLine2,
    city: details.city,
    deliveryInstructions: details.deliveryInstructions,
    riderId: details.riderId,
    deliveryStatus: details.deliveryStatus,
    createdAt: details.createdAt.toISOString(),
    updatedAt: details.updatedAt.toISOString(),
  };
}

@Controller("orders/:orderId/delivery")
export class DeliveryDetailsController {
  constructor(private readonly deliveryDetailsService: DeliveryDetailsService) {}

  @Get()
  @RequirePermission("pos.sell")
  async get(@Param() params: unknown): Promise<DeliveryDetails | null> {
    const tenant = requireTenant();
    const { orderId } = parseOrBadRequest(OrderIdParamSchema, params);
    const details = await this.deliveryDetailsService.get(tenant.restaurantId, orderId);
    return details ? toDetailsResponse(details) : null;
  }

  @Put()
  @RequirePermission("pos.sell")
  async setDetails(@Param() params: unknown, @Body() body: unknown): Promise<DeliveryDetails> {
    const tenant = requireTenant();
    const { orderId } = parseOrBadRequest(OrderIdParamSchema, params);
    const request = parseOrBadRequest(SetDeliveryDetailsSchema, body);
    const details = await this.deliveryDetailsService.setDetails({ ...request, restaurantId: tenant.restaurantId, orderId, actorUserId: tenant.userId });
    return toDetailsResponse(details);
  }

  @Patch("rider")
  @RequirePermission("pos.sell")
  async assignRider(@Param() params: unknown, @Body() body: unknown): Promise<DeliveryDetails> {
    const tenant = requireTenant();
    const { orderId } = parseOrBadRequest(OrderIdParamSchema, params);
    const request = parseOrBadRequest(AssignRiderSchema, body);
    const details = await this.deliveryDetailsService.assignRider({ ...request, restaurantId: tenant.restaurantId, orderId, actorUserId: tenant.userId });
    return toDetailsResponse(details);
  }

  @Patch("status")
  @RequirePermission("pos.sell")
  async updateStatus(@Param() params: unknown, @Body() body: unknown): Promise<DeliveryDetails> {
    const tenant = requireTenant();
    const { orderId } = parseOrBadRequest(OrderIdParamSchema, params);
    const request = parseOrBadRequest(UpdateDeliveryStatusSchema, body);
    const details = await this.deliveryDetailsService.updateStatus({ ...request, restaurantId: tenant.restaurantId, orderId, actorUserId: tenant.userId });
    return toDetailsResponse(details);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
