import { KitchenTicketSchema, type KitchenTicket } from "@mezbaan/contracts";
import { apiRequest } from "../shared/api-client.js";

export type { KitchenTicket };

/** A 3-hour rolling window, not the whole branch's history — bumped tickets
 * from last week have no business slowing down today's live queue. */
const RECENT_WINDOW_MS = 3 * 60 * 60 * 1000;

/** includeBumped: true — the Kitchen Display derives both the live queue
 * (unbumped tickets) and "order ready" status (every ticket for an order
 * bumped) from one fetch, rather than polling twice. */
export async function fetchKitchenTickets(deviceToken: string): Promise<KitchenTicket[]> {
  const since = new Date(Date.now() - RECENT_WINDOW_MS).toISOString();
  const data = await apiRequest<unknown[]>(`/kitchen-tickets/terminal?includeBumped=true&since=${encodeURIComponent(since)}`, { deviceToken });
  return data.map((item) => KitchenTicketSchema.parse(item));
}

export async function bumpTicket(deviceToken: string, ticket: Pick<KitchenTicket, "orderId" | "firedAt" | "stationId">): Promise<void> {
  await apiRequest("/kitchen-tickets/terminal/bump", {
    method: "POST",
    deviceToken,
    body: { orderId: ticket.orderId, firedAt: ticket.firedAt, stationId: ticket.stationId },
  });
}

export async function recallTicket(deviceToken: string, ticket: Pick<KitchenTicket, "orderId" | "firedAt" | "stationId">): Promise<void> {
  await apiRequest("/kitchen-tickets/terminal/recall", {
    method: "POST",
    deviceToken,
    body: { orderId: ticket.orderId, firedAt: ticket.firedAt, stationId: ticket.stationId },
  });
}
