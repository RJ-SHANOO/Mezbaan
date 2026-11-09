import { Body, Controller, Get, Param, Patch, Post, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { CreateComboSlotSchema, UpdateComboSlotSchema, type ComboSlot } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { ComboSlotsService, type ComboSlotRecord } from "./combo-slots.service.js";
import { parseOrBadRequest } from "./validation.js";

const ComboIdParamSchema = z.object({ comboId: z.string().uuid() });
const SlotIdParamSchema = z.object({ comboId: z.string().uuid(), slotId: z.string().uuid() });

function toSlotResponse(slot: ComboSlotRecord): ComboSlot {
  return {
    id: slot.id,
    comboId: slot.comboId,
    name: slot.name,
    kind: slot.kind,
    minSelections: slot.minSelections,
    maxSelections: slot.maxSelections,
    sortOrder: slot.sortOrder,
    createdAt: slot.createdAt.toISOString(),
    updatedAt: slot.updatedAt.toISOString(),
  };
}

@Controller("combos/:comboId/slots")
export class ComboSlotsController {
  constructor(private readonly comboSlotsService: ComboSlotsService) {}

  @Get()
  @RequirePermission("menu.manage")
  async list(@Param() params: unknown): Promise<ComboSlot[]> {
    const tenant = requireTenant();
    const { comboId } = parseOrBadRequest(ComboIdParamSchema, params);
    const slots = await this.comboSlotsService.list(tenant.restaurantId, comboId);
    return slots.map(toSlotResponse);
  }

  @Post()
  @RequirePermission("menu.manage")
  async create(@Param() params: unknown, @Body() body: unknown): Promise<ComboSlot> {
    const tenant = requireTenant();
    const { comboId } = parseOrBadRequest(ComboIdParamSchema, params);
    const request = parseOrBadRequest(CreateComboSlotSchema, body);
    const slot = await this.comboSlotsService.create({ ...request, restaurantId: tenant.restaurantId, comboId, actorUserId: tenant.userId });
    return toSlotResponse(slot);
  }

  @Patch(":slotId")
  @RequirePermission("menu.manage")
  async update(@Param() params: unknown, @Body() body: unknown): Promise<ComboSlot> {
    const tenant = requireTenant();
    const { slotId } = parseOrBadRequest(SlotIdParamSchema, params);
    const request = parseOrBadRequest(UpdateComboSlotSchema, body);
    const slot = await this.comboSlotsService.update({ ...request, restaurantId: tenant.restaurantId, slotId, actorUserId: tenant.userId });
    return toSlotResponse(slot);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
