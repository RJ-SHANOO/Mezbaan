import { Body, Controller, Get, Post, Query, UnauthorizedException } from "@nestjs/common";
import {
  ListSupplierItemPricesQuerySchema,
  RecordSupplierItemPriceSchema,
  type SupplierItemPrice,
  type SupplierItemPricePage,
} from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { SupplierItemPricesService, type SupplierItemPriceRecord } from "./supplier-item-prices.service.js";
import { parseOrBadRequest } from "./validation.js";

function toPriceResponse(price: SupplierItemPriceRecord): SupplierItemPrice {
  return {
    id: price.id,
    supplierId: price.supplierId,
    itemId: price.itemId,
    unitPriceMinor: price.unitPriceMinor.toString(),
    currency: price.currency,
    unitId: price.unitId,
    note: price.note,
    actorUserId: price.actorUserId,
    createdAt: price.createdAt.toISOString(),
  };
}

@Controller("supplier-item-prices")
export class SupplierItemPricesController {
  constructor(private readonly supplierItemPricesService: SupplierItemPricesService) {}

  @Get()
  @RequirePermission("suppliers.manage")
  async list(@Query() query: unknown): Promise<SupplierItemPricePage> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ListSupplierItemPricesQuerySchema, query);
    const page = await this.supplierItemPricesService.list({ restaurantId: tenant.restaurantId, ...request });
    return { items: page.items.map(toPriceResponse), nextCursor: page.nextCursor };
  }

  @Post()
  @RequirePermission("suppliers.manage")
  async record(@Body() body: unknown): Promise<SupplierItemPrice> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(RecordSupplierItemPriceSchema, body);
    const price = await this.supplierItemPricesService.record({
      ...request,
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.userId,
      unitPriceMinor: BigInt(request.unitPriceMinor),
    });
    return toPriceResponse(price);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
