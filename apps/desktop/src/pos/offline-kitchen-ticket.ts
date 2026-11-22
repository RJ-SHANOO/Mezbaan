import type { KitchenTicket } from "@mezbaan/contracts";
import type { CartLine } from "./cart.js";

/** P3-05: an offline-fired ticket's composite identity, mirroring the
 * server's own (orderId, firedAt, stationId) key shape (KitchenTicketsService)
 * — used as the hub relay's entityId so a re-publish (e.g. a bump) targets
 * the same entry rather than creating a new one. */
export function offlineTicketEntityId(ticket: Pick<KitchenTicket, "orderId" | "firedAt" | "stationId">): string {
  return `${ticket.orderId}:${ticket.firedAt}:${ticket.stationId ?? "unrouted"}`;
}

/**
 * Builds a KitchenTicket-shaped payload from the offline cart's own lines,
 * for relaying over the branch hub (P3-05) — there is no real server-side
 * order for this sale yet (it's only created once the sale actually syncs,
 * P2-45/exit-gate hardening), so `orderId` is this cart session's own
 * client-generated draft id, not a real order's. `branchId` is left empty:
 * every device on one hub already belongs to the same branch by
 * construction, so nothing here ever filters a hub-relayed ticket by it.
 *
 * Deliberately `stationId: null` always — P3-01's routing rules are never
 * synced to this terminal's local cache (menu_cache.rs has no such table),
 * so an offline-fired ticket cannot resolve a station; it shows under
 * "Unrouted" on the Kitchen Display, the same bucket an online ticket with
 * no matching rule falls into. `printerHost`/`printerPort` are therefore
 * always null too (no station to look a printer up on) — an offline-fired
 * ticket is display-only, never auto-printed (P3-04's printNewlyFiredTickets
 * already skips any ticket with no printerHost, so this needs no special
 * handling there). Documented gap, not fixed here — closing it needs
 * syncing kitchen_routing_rules/kitchen_stations down to the Rust cache,
 * which is its own task.
 */
export function buildOfflineKitchenTicket(draftOrderId: string, lines: CartLine[], rush: boolean): KitchenTicket {
  return {
    orderId: draftOrderId,
    branchId: "",
    tableId: null,
    orderType: "takeaway",
    stationId: null,
    stationName: null,
    printerHost: null,
    printerPort: null,
    rush,
    firedAt: new Date().toISOString(),
    firedByUserId: null,
    bumped: false,
    bumpedAt: null,
    bumpedByUserId: null,
    items: lines.map((line) => ({
      orderItemId: line.lineId,
      name: line.name,
      quantity: line.quantity,
      notes: null,
      seatNumber: null,
      course: null,
      modifiers: line.modifiers.map((modifier) => ({ name: modifier.name, quantity: 1 })),
      voided: false,
    })),
  };
}
