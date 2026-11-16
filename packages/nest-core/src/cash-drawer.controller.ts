import { Body, Controller, Get, Param, Post, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { LogDrawerOpenSchema, RecordCashMovementSchema, type CashDrawerOpenEvent, type CashMovement } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { CashMovementsService, type CashDrawerOpenEventRecord, type CashMovementRecord } from "./cash-movements.service.js";
import { parseOrBadRequest } from "./validation.js";

const ShiftIdParamSchema = z.object({ shiftId: z.string().uuid() });

function toMovementResponse(row: CashMovementRecord): CashMovement {
  return {
    id: row.id,
    shiftId: row.shiftId,
    direction: row.direction,
    amountMinor: row.amountMinor.toString(),
    currency: row.currency,
    reasonCode: row.reasonCode,
    note: row.note,
    actorUserId: row.actorUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

function toDrawerEventResponse(row: CashDrawerOpenEventRecord): CashDrawerOpenEvent {
  return { id: row.id, shiftId: row.shiftId, trigger: row.trigger, actorUserId: row.actorUserId, createdAt: row.createdAt.toISOString() };
}

/** P2-28, POS side: cash in/out and drawer-open logging against an open
 * shift, gated by pos.sell like any other sale-time cash action. Lives in
 * api-pos's OrdersModule alongside shifts/payments/refunds. */
@Controller("shifts/:shiftId")
export class CashDrawerController {
  constructor(private readonly cashMovementsService: CashMovementsService) {}

  @Post("cash-in")
  @RequirePermission("pos.sell")
  async cashIn(@Param() params: unknown, @Body() body: unknown): Promise<CashMovement> {
    const tenant = requireTenant();
    const { shiftId } = parseOrBadRequest(ShiftIdParamSchema, params);
    const request = parseOrBadRequest(RecordCashMovementSchema, body);
    const movement = await this.cashMovementsService.recordCashIn({ restaurantId: tenant.restaurantId, actorUserId: tenant.userId, shiftId, amountMinor: BigInt(request.amountMinor), reasonCode: request.reasonCode, note: request.note });
    return toMovementResponse(movement);
  }

  @Post("cash-out")
  @RequirePermission("pos.sell")
  async cashOut(@Param() params: unknown, @Body() body: unknown): Promise<CashMovement> {
    const tenant = requireTenant();
    const { shiftId } = parseOrBadRequest(ShiftIdParamSchema, params);
    const request = parseOrBadRequest(RecordCashMovementSchema, body);
    const movement = await this.cashMovementsService.recordCashOut({ restaurantId: tenant.restaurantId, actorUserId: tenant.userId, shiftId, amountMinor: BigInt(request.amountMinor), reasonCode: request.reasonCode, note: request.note });
    return toMovementResponse(movement);
  }

  @Get("cash-movements")
  @RequirePermission("pos.sell")
  async listMovements(@Param() params: unknown): Promise<CashMovement[]> {
    const tenant = requireTenant();
    const { shiftId } = parseOrBadRequest(ShiftIdParamSchema, params);
    const movements = await this.cashMovementsService.listMovementsForShift({ restaurantId: tenant.restaurantId, shiftId });
    return movements.map(toMovementResponse);
  }

  @Post("drawer-open")
  @RequirePermission("pos.sell")
  async logDrawerOpen(@Param() params: unknown, @Body() body: unknown): Promise<CashDrawerOpenEvent> {
    const tenant = requireTenant();
    const { shiftId } = parseOrBadRequest(ShiftIdParamSchema, params);
    const request = parseOrBadRequest(LogDrawerOpenSchema, body);
    const event = await this.cashMovementsService.logDrawerOpen({ restaurantId: tenant.restaurantId, actorUserId: tenant.userId, shiftId, trigger: request.trigger ?? "manual" });
    return toDrawerEventResponse(event);
  }

  @Get("drawer-opens")
  @RequirePermission("pos.sell")
  async listDrawerOpens(@Param() params: unknown): Promise<CashDrawerOpenEvent[]> {
    const tenant = requireTenant();
    const { shiftId } = parseOrBadRequest(ShiftIdParamSchema, params);
    const events = await this.cashMovementsService.listDrawerOpenEventsForShift({ restaurantId: tenant.restaurantId, shiftId });
    return events.map(toDrawerEventResponse);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
