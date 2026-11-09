import { Body, Controller, Delete, Get, Param, Put, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { AttachComboSlotItemSchema, type ComboSlotItem } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { ComboSlotItemsService, type ComboSlotItemRecord } from "./combo-slot-items.service.js";
import { parseOrBadRequest } from "./validation.js";

const SlotIdParamSchema = z.object({ comboId: z.string().uuid(), slotId: z.string().uuid() });
const ItemParamSchema = z.object({ comboId: z.string().uuid(), slotId: z.string().uuid(), productId: z.string().uuid() });

function toItemResponse(item: ComboSlotItemRecord): ComboSlotItem {
  return { id: item.id, comboSlotId: item.comboSlotId, productId: item.productId, sortOrder: item.sortOrder };
}

@Controller("combos/:comboId/slots/:slotId/items")
export class ComboSlotItemsController {
  constructor(private readonly comboSlotItemsService: ComboSlotItemsService) {}

  @Get()
  @RequirePermission("menu.manage")
  async list(@Param() params: unknown): Promise<ComboSlotItem[]> {
    const tenant = requireTenant();
    const { slotId } = parseOrBadRequest(SlotIdParamSchema, params);
    const items = await this.comboSlotItemsService.list(tenant.restaurantId, slotId);
    return items.map(toItemResponse);
  }

  @Put()
  @RequirePermission("menu.manage")
  async attach(@Param() params: unknown, @Body() body: unknown): Promise<ComboSlotItem> {
    const tenant = requireTenant();
    const { slotId } = parseOrBadRequest(SlotIdParamSchema, params);
    const request = parseOrBadRequest(AttachComboSlotItemSchema, body);
    const item = await this.comboSlotItemsService.attach({ ...request, restaurantId: tenant.restaurantId, comboSlotId: slotId, actorUserId: tenant.userId });
    return toItemResponse(item);
  }

  @Delete(":productId")
  @RequirePermission("menu.manage")
  async detach(@Param() params: unknown): Promise<{ detached: true }> {
    const tenant = requireTenant();
    const { slotId, productId } = parseOrBadRequest(ItemParamSchema, params);
    await this.comboSlotItemsService.detach({ restaurantId: tenant.restaurantId, comboSlotId: slotId, productId, actorUserId: tenant.userId });
    return { detached: true };
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
