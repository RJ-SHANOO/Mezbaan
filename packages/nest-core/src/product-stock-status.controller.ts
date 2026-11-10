import { Body, Controller, Delete, Get, Put, Query, UnauthorizedException } from "@nestjs/common";
import { ClearOutOfStockQuerySchema, ListOutOfStockQuerySchema, MarkOutOfStockSchema, type OutOfStockMarking } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { ProductStockStatusService, type ProductStockStatusRecord } from "./product-stock-status.service.js";
import { parseOrBadRequest } from "./validation.js";

function toOutOfStockResponse(marking: ProductStockStatusRecord): OutOfStockMarking {
  return {
    id: marking.id,
    branchId: marking.branchId,
    productId: marking.productId,
    variantId: marking.variantId,
    reason: marking.reason,
    markedByUserId: marking.markedByUserId,
    markedAt: marking.markedAt.toISOString(),
  };
}

@Controller("stock-status")
export class ProductStockStatusController {
  constructor(private readonly productStockStatusService: ProductStockStatusService) {}

  @Get()
  @RequirePermission("pos.mark_out_of_stock")
  async list(@Query() query: unknown): Promise<OutOfStockMarking[]> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ListOutOfStockQuerySchema, query);
    const markings = await this.productStockStatusService.list({ restaurantId: tenant.restaurantId, branchId: request.branchId });
    return markings.map(toOutOfStockResponse);
  }

  @Put()
  @RequirePermission("pos.mark_out_of_stock")
  async mark(@Body() body: unknown): Promise<OutOfStockMarking> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(MarkOutOfStockSchema, body);
    const marking = await this.productStockStatusService.markOutOfStock({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toOutOfStockResponse(marking);
  }

  @Delete()
  @RequirePermission("pos.mark_out_of_stock")
  async clear(@Query() query: unknown): Promise<{ cleared: true }> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ClearOutOfStockQuerySchema, query);
    await this.productStockStatusService.clearOutOfStock({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return { cleared: true };
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
