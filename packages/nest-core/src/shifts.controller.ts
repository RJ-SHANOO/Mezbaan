import { Body, Controller, Get, Param, Post, Query, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { CloseShiftSchema, ListShiftsQuerySchema, OpenShiftSchema, type Shift, type ShiftPage } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { ShiftsService, type ShiftRecord } from "./shifts.service.js";
import { parseOrBadRequest } from "./validation.js";

const ShiftIdParamSchema = z.object({ id: z.string().uuid() });
const DeviceQuerySchema = z.object({ deviceId: z.string().uuid() });

function toShiftResponse(row: ShiftRecord): Shift {
  return {
    id: row.id,
    branchId: row.branchId,
    deviceId: row.deviceId,
    openedByUserId: row.openedByUserId,
    openingFloatMinor: row.openingFloatMinor.toString(),
    openingNote: row.openingNote,
    currency: row.currency,
    status: row.status,
    openedAt: row.openedAt.toISOString(),
    closedByUserId: row.closedByUserId,
    closedAt: row.closedAt?.toISOString() ?? null,
    closingCashCounts: row.closingCashCounts?.map((entry) => ({ denominationMinor: entry.denominationMinor.toString(), count: entry.count })) ?? null,
    countedCashMinor: row.countedCashMinor?.toString() ?? null,
    closingNote: row.closingNote,
  };
}

/** P2-27: shift open/close at a till (device), gated by pos.sell like any
 * other POS action — opening a shift and taking money into a drawer is an
 * ordinary start-of-day action, not an escalation. Lives in api-pos's
 * OrdersModule alongside payments/refunds/credit accounts. */
@Controller("shifts")
export class ShiftsController {
  constructor(private readonly shiftsService: ShiftsService) {}

  @Post()
  @RequirePermission("pos.sell")
  async open(@Body() body: unknown): Promise<Shift> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(OpenShiftSchema, body);
    const shift = await this.shiftsService.open({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.userId,
      deviceId: request.deviceId,
      openingFloatMinor: BigInt(request.openingFloatMinor),
      currency: request.currency,
      openingNote: request.openingNote,
    });
    return toShiftResponse(shift);
  }

  // Registered before ":id" below — Nest matches GET routes on one
  // controller in declaration order, and "/shifts/open" would otherwise be
  // swallowed by ":id" (failing UUID parsing instead of reaching this one).
  @Get("open")
  @RequirePermission("pos.sell")
  async getOpenForDevice(@Query() query: unknown): Promise<Shift | null> {
    const tenant = requireTenant();
    const { deviceId } = parseOrBadRequest(DeviceQuerySchema, query);
    const shift = await this.shiftsService.getOpenShiftForDevice(tenant.restaurantId, deviceId);
    return shift ? toShiftResponse(shift) : null;
  }

  @Get()
  @RequirePermission("pos.sell")
  async list(@Query() query: unknown): Promise<ShiftPage> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ListShiftsQuerySchema, query);
    const page = await this.shiftsService.listForBranch(tenant.restaurantId, request.branchId, request.cursor, request.limit);
    return { items: page.items.map(toShiftResponse), nextCursor: page.nextCursor };
  }

  @Get(":id")
  @RequirePermission("pos.sell")
  async get(@Param() params: unknown): Promise<Shift> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(ShiftIdParamSchema, params);
    const shift = await this.shiftsService.get(tenant.restaurantId, id);
    return toShiftResponse(shift);
  }

  @Post(":id/close")
  @RequirePermission("pos.sell")
  async close(@Param() params: unknown, @Body() body: unknown): Promise<Shift> {
    const tenant = requireTenant();
    const { id } = parseOrBadRequest(ShiftIdParamSchema, params);
    const request = parseOrBadRequest(CloseShiftSchema, body);
    const shift = await this.shiftsService.close({
      restaurantId: tenant.restaurantId,
      actorUserId: tenant.userId,
      shiftId: id,
      denominationCounts: request.denominationCounts.map((entry) => ({ denominationMinor: BigInt(entry.denominationMinor), count: entry.count })),
      closingNote: request.closingNote,
    });
    return toShiftResponse(shift);
  }
}

function requireTenant(): { restaurantId: string; userId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId || !tenant.userId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId, userId: tenant.userId };
}
