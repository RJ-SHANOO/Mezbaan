import { Body, Controller, Get, Param, Post, Put, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { SetVoidReasonCodeSchema, VoidOrderItemSchema, type VoidOutcome, type VoidReasonCode } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { VoidsService, type VoidOutcome as VoidOutcomeRecord, type VoidReasonCodeRecord } from "./voids.service.js";
import { parseOrBadRequest } from "./validation.js";

const ItemVoidParamSchema = z.object({ orderId: z.string().uuid(), itemId: z.string().uuid() });

function toReasonCodeResponse(row: VoidReasonCodeRecord): VoidReasonCode {
  return { id: row.id, code: row.code, label: row.label, isActive: row.isActive, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

function toOutcomeResponse(outcome: VoidOutcomeRecord): VoidOutcome {
  return { requiredApproval: outcome.requiredApproval, approvedByUserId: outcome.approvedByUserId };
}

/** P2-23, admin side: the restaurant-defined void reason codes — same
 * menu.manage tier as discount-reason-codes, lives in CatalogModule for
 * api-admin. Unlike discounts, voids have no "limits" settings — approval
 * is a binary check on whether the item was already fired, not a
 * configurable threshold. */
@Controller("void-reason-codes")
export class VoidReasonCodesController {
  constructor(private readonly voidsService: VoidsService) {}

  @Get()
  @RequirePermission("menu.manage")
  async list(): Promise<VoidReasonCode[]> {
    const tenant = requireTenant();
    const codes = await this.voidsService.listReasonCodes(tenant.restaurantId);
    return codes.map(toReasonCodeResponse);
  }

  @Put()
  @RequirePermission("menu.manage")
  async set(@Body() body: unknown): Promise<VoidReasonCode> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(SetVoidReasonCodeSchema, body);
    const code = await this.voidsService.setReasonCode({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toReasonCodeResponse(code);
  }
}

/** P2-23, POS side: voiding is gated by pos.sell like any other order edit —
 * the manager-PIN escalation for an already-fired item happens inside
 * VoidsService itself (ManagerPinService checks pos.void.approve), not via a
 * different route permission. There's no DELETE here — a void is final, not
 * a reversible toggle (rule 6: always recorded, never quietly undone). */
@Controller("orders/:orderId/items/:itemId/void")
export class OrderItemVoidController {
  constructor(private readonly voidsService: VoidsService) {}

  @Post()
  @RequirePermission("pos.sell")
  async voidItem(@Param() params: unknown, @Body() body: unknown): Promise<VoidOutcome> {
    const tenant = requireTenant();
    const { orderId, itemId } = parseOrBadRequest(ItemVoidParamSchema, params);
    const request = parseOrBadRequest(VoidOrderItemSchema, body);
    const outcome = await this.voidsService.voidItem({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.userId,
      orderId,
      itemId,
      reasonCode: request.reasonCode,
      managerUserId: request.managerUserId,
      managerPin: request.managerPin,
      stockDisposition: request.stockDisposition,
    });
    return toOutcomeResponse(outcome);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
