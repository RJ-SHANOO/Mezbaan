import { Body, Controller, Get, Put, UnauthorizedException } from "@nestjs/common";
import { SetCashMovementReasonCodeSchema, type CashMovementReasonCode } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { CashMovementsService, type CashMovementReasonCodeRecord } from "./cash-movements.service.js";
import { parseOrBadRequest } from "./validation.js";

function toReasonCodeResponse(row: CashMovementReasonCodeRecord): CashMovementReasonCode {
  return { id: row.id, code: row.code, label: row.label, isActive: row.isActive, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

/** P2-28, admin side: the restaurant-defined cash-movement reason codes —
 * same menu.manage tier as discount/void/refund reason codes, lives in
 * api-admin's CatalogModule. */
@Controller("cash-movement-reason-codes")
export class CashMovementReasonCodesController {
  constructor(private readonly cashMovementsService: CashMovementsService) {}

  @Get()
  @RequirePermission("menu.manage")
  async list(): Promise<CashMovementReasonCode[]> {
    const tenant = requireTenant();
    const codes = await this.cashMovementsService.listReasonCodes(tenant.restaurantId);
    return codes.map(toReasonCodeResponse);
  }

  @Put()
  @RequirePermission("menu.manage")
  async set(@Body() body: unknown): Promise<CashMovementReasonCode> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(SetCashMovementReasonCodeSchema, body);
    const code = await this.cashMovementsService.setReasonCode({ ...request, restaurantId: tenant.restaurantId, actorUserId: tenant.userId });
    return toReasonCodeResponse(code);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
