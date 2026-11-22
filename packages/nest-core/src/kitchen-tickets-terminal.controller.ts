import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { BumpKitchenTicketSchema, ListKitchenTicketsQuerySchema, OrderReadyStatusQuerySchema, RecallKitchenTicketSchema, type KitchenTicket, type OrderReadyStatus } from "@mezbaan/contracts";
import { CurrentDevice, DeviceAuthGuard } from "./device-auth.guard.js";
import type { DeviceRecord } from "./device.service.js";
import { KitchenTicketsService } from "./kitchen-tickets.service.js";
import { toTicketResponse } from "./kitchen-tickets.controller.js";
import { parseOrBadRequest } from "./validation.js";

const NO_DEFAULT_ACTOR = "This device has no default actor configured — ask an admin to set one before bumping or recalling tickets";

/** Device-token-authenticated equivalent of KitchenTicketsController — the
 * desktop Kitchen Display window has no user login (same gap P2-45's
 * devices.defaultActorUserId was built for), so every route here is scoped
 * to the calling device's own branch/restaurant rather than a JWT's tenant
 * context, and bump/recall are attributed to the device's default actor. */
@Controller("kitchen-tickets/terminal")
@UseGuards(DeviceAuthGuard)
export class KitchenTicketsTerminalController {
  constructor(private readonly kitchenTicketsService: KitchenTicketsService) {}

  @Get()
  async list(@CurrentDevice() device: DeviceRecord, @Query() query: unknown): Promise<KitchenTicket[]> {
    const request = parseOrBadRequest(ListKitchenTicketsQuerySchema, query);
    const tickets = await this.kitchenTicketsService.getTickets({
      restaurantId: device.restaurantId,
      branchId: device.branchId,
      ...request,
      since: request.since !== undefined ? new Date(request.since) : undefined,
    });
    return tickets.map(toTicketResponse);
  }

  @Get("order-ready")
  async orderReady(@CurrentDevice() device: DeviceRecord, @Query() query: unknown): Promise<OrderReadyStatus> {
    const { orderId } = parseOrBadRequest(OrderReadyStatusQuerySchema, query);
    const ready = await this.kitchenTicketsService.isOrderReady({ restaurantId: device.restaurantId, branchId: device.branchId, orderId });
    return { orderId, ready };
  }

  @Post("bump")
  async bump(@CurrentDevice() device: DeviceRecord, @Body() body: unknown): Promise<{ bumped: true }> {
    const actorUserId = requireDefaultActor(device);
    const request = parseOrBadRequest(BumpKitchenTicketSchema, body);
    await this.kitchenTicketsService.bumpTicket({
      restaurantId: device.restaurantId,
      branchId: device.branchId,
      actorUserId,
      orderId: request.orderId,
      firedAt: new Date(request.firedAt),
      stationId: request.stationId,
    });
    return { bumped: true };
  }

  @Post("recall")
  async recall(@CurrentDevice() device: DeviceRecord, @Body() body: unknown): Promise<{ recalled: true }> {
    const actorUserId = requireDefaultActor(device);
    const request = parseOrBadRequest(RecallKitchenTicketSchema, body);
    await this.kitchenTicketsService.recallTicket({
      restaurantId: device.restaurantId,
      actorUserId,
      orderId: request.orderId,
      firedAt: new Date(request.firedAt),
      stationId: request.stationId,
    });
    return { recalled: true };
  }
}

function requireDefaultActor(device: DeviceRecord): string {
  if (!device.defaultActorUserId) throw new BadRequestException(NO_DEFAULT_ACTOR);
  return device.defaultActorUserId;
}
