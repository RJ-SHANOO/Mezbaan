import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { LinkSupplierItemSchema, ListSupplierItemsQuerySchema, UpdateSupplierItemSchema, type SupplierItem } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { SupplierItemsService, type SupplierItemRecord } from "./supplier-items.service.js";
import { parseOrBadRequest } from "./validation.js";

const SupplierItemIdParamSchema = z.object({ id: z.string().uuid() });

function toSupplierItemResponse(link: SupplierItemRecord): SupplierItem {
  return {
    id: link.id,
    supplierId: link.supplierId,
    itemId: link.itemId,
    supplierSku: link.supplierSku,
    createdAt: link.createdAt.toISOString(),
    updatedAt: link.updatedAt.toISOString(),
  };
}

@Controller("supplier-items")
export class SupplierItemsController {
  constructor(private readonly supplierItemsService: SupplierItemsService) {}

  @Get()
  @RequirePermission("suppliers.manage")
  async list(@Query() query: unknown): Promise<SupplierItem[]> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ListSupplierItemsQuerySchema, query);
    const links = await this.supplierItemsService.list({ restaurantId: tenant.restaurantId, ...request });
    return links.map(toSupplierItemResponse);
  }

  @Post()
  @RequirePermission("suppliers.manage")
  async link(@Body() body: unknown): Promise<SupplierItem> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(LinkSupplierItemSchema, body);
    const link = await this.supplierItemsService.link({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toSupplierItemResponse(link);
  }

  @Patch(":id")
  @RequirePermission("suppliers.manage")
  async update(@Param() params: unknown, @Body() body: unknown): Promise<SupplierItem> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(SupplierItemIdParamSchema, params);
    const request = parseOrBadRequest(UpdateSupplierItemSchema, body);
    const link = await this.supplierItemsService.update({ restaurantId: tenant.restaurantId, actorUserId: tenant.userId, supplierItemId: id, supplierSku: request.supplierSku });
    return toSupplierItemResponse(link);
  }

  @Delete(":id")
  @RequirePermission("suppliers.manage")
  async unlink(@Param() params: unknown): Promise<{ success: true }> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(SupplierItemIdParamSchema, params);
    await this.supplierItemsService.unlink({ restaurantId: tenant.restaurantId, actorUserId: tenant.userId, supplierItemId: id });
    return { success: true };
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
