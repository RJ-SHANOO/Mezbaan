import { Controller, Get, Query, UnauthorizedException } from "@nestjs/common";
import { ListKitchenTicketsQuerySchema, type KitchenTicket } from "@mezbaan/contracts";
import { getTenantContext } from "./tenant-context.js";
import { RequirePermission } from "./permission.decorator.js";
import { KitchenTicketsService, type KitchenTicketRecord } from "./kitchen-tickets.service.js";
import { parseOrBadRequest } from "./validation.js";

export function toTicketResponse(ticket: KitchenTicketRecord): KitchenTicket {
  return {
    orderId: ticket.orderId,
    branchId: ticket.branchId,
    tableId: ticket.tableId,
    orderType: ticket.orderType,
    stationId: ticket.stationId,
    stationName: ticket.stationName,
    printerHost: ticket.printerHost,
    printerPort: ticket.printerPort,
    rush: ticket.rush,
    firedAt: ticket.firedAt.toISOString(),
    firedByUserId: ticket.firedByUserId,
    bumped: ticket.bumped,
    bumpedAt: ticket.bumpedAt?.toISOString() ?? null,
    bumpedByUserId: ticket.bumpedByUserId,
    items: ticket.items,
  };
}

/** Read-only, for an authenticated dashboard view (e.g. apps/web). The
 * desktop Kitchen Display has no login flow — see KitchenTicketsTerminalController
 * for its device-token-authenticated equivalent, including bump/recall. */
@Controller("kitchen-tickets")
export class KitchenTicketsController {
  constructor(private readonly kitchenTicketsService: KitchenTicketsService) {}

  @Get()
  @RequirePermission("kitchen.view")
  async list(@Query() query: unknown): Promise<KitchenTicket[]> {
    const tenant = requireTenant();
    const request = parseOrBadRequest(ListKitchenTicketsQuerySchema, query);
    const tickets = await this.kitchenTicketsService.getTickets({ restaurantId: tenant.restaurantId, ...request, since: request.since !== undefined ? new Date(request.since) : undefined });
    return tickets.map(toTicketResponse);
  }
}

function requireTenant(): { restaurantId: string } {
  const tenant = getTenantContext();
  if (!tenant.authenticated || !tenant.restaurantId) {
    throw new UnauthorizedException("Authentication required");
  }
  return { restaurantId: tenant.restaurantId };
}
