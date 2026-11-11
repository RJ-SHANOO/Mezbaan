import { Body, Controller, Get, Param, Patch, Post, Query, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { CreateDeliveryRiderSchema, UpdateDeliveryRiderSchema, type DeliveryRider } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { DeliveryRidersService, type DeliveryRiderRecord } from "./delivery-riders.service.js";
import { parseOrBadRequest } from "./validation.js";

const RiderIdParamSchema = z.object({ id: z.string().uuid() });
const ListRidersQuerySchema = z.object({ branchId: z.string().uuid().optional() });

function toRiderResponse(rider: DeliveryRiderRecord): DeliveryRider {
  return {
    id: rider.id,
    branchId: rider.branchId,
    name: rider.name,
    phone: rider.phone,
    isActive: rider.isActive,
    createdAt: rider.createdAt.toISOString(),
    updatedAt: rider.updatedAt.toISOString(),
  };
}

@Controller("delivery-riders")
export class DeliveryRidersController {
  constructor(private readonly deliveryRidersService: DeliveryRidersService) {}

  @Get()
  @RequirePermission("pos.sell")
  async list(@Query() query: unknown): Promise<DeliveryRider[]> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ListRidersQuerySchema, query);
    const riders = await this.deliveryRidersService.list(tenant.restaurantId, request.branchId);
    return riders.map(toRiderResponse);
  }

  @Post()
  @RequirePermission("pos.sell")
  async create(@Body() body: unknown): Promise<DeliveryRider> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(CreateDeliveryRiderSchema, body);
    const rider = await this.deliveryRidersService.create({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toRiderResponse(rider);
  }

  @Patch(":id")
  @RequirePermission("pos.sell")
  async update(@Param() params: unknown, @Body() body: unknown): Promise<DeliveryRider> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(RiderIdParamSchema, params);
    const request = parseOrBadRequest(UpdateDeliveryRiderSchema, body);
    const rider = await this.deliveryRidersService.update({ ...request, restaurantId: tenant.restaurantId, riderId: id, actorUserId: tenant.userId });
    return toRiderResponse(rider);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
