import { invoke } from "@tauri-apps/api/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { getDeviceIdentity } from "../shared/device-identity-client.js";
import type { HubClient, StateEntry } from "../shared/hub-client.js";
import { connectToBranchHub } from "../shared/hub-connection.js";
import { SyncStatusIndicator } from "../shared/SyncStatusIndicator.js";
import { ApiError } from "../shared/api-client.js";
import { printNewlyFiredTickets } from "./kitchen-print.js";
import { bumpTicket, fetchKitchenTickets, recallTicket, type KitchenTicket } from "./kitchen-ticket-client.js";

const POLL_INTERVAL_MS = 5000;
const TIMER_TICK_MS = 1000;
const TICKETS_QUERY_KEY = ["kitchen-tickets"];
const KITCHEN_TICKET_ENTITY_KIND = "kitchen_ticket";

/** P3-05: a hub-relayed ticket (offline-fired, no real server order yet —
 * see offline-kitchen-ticket.ts) alongside a normal server-polled one. Only
 * `source` decides whether bump/recall calls the server API or republishes
 * over the hub — the rendered shape is otherwise identical. */
type DisplayTicket = KitchenTicket & { source: "server" | "hub" };

function ticketKey(ticket: Pick<KitchenTicket, "orderId" | "firedAt" | "stationId">): string {
  return `${ticket.orderId}:${ticket.firedAt}:${ticket.stationId ?? "unrouted"}`;
}

type TicketAgeLevel = "fresh" | "warning" | "late";

function ticketAgeLevel(firedAt: string, now: number): TicketAgeLevel {
  const elapsedMs = now - new Date(firedAt).getTime();
  if (elapsedMs >= 10 * 60 * 1000) return "late";
  if (elapsedMs >= 5 * 60 * 1000) return "warning";
  return "fresh";
}

function formatElapsed(firedAt: string, now: number): string {
  const elapsedSec = Math.max(0, Math.floor((now - new Date(firedAt).getTime()) / 1000));
  const minutes = Math.floor(elapsedSec / 60);
  const seconds = elapsedSec % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

const AGE_BADGE_CLASSES: Record<TicketAgeLevel, string> = {
  fresh: "bg-emerald-100 text-emerald-700",
  warning: "bg-amber-100 text-amber-700",
  late: "bg-red-100 text-red-700",
};

/** Ready = every ticket fired for this order (that still has a non-voided
 * item) has been bumped — a dish split across stations needs all of them
 * done, not just one. */
function readyOrderIds(tickets: DisplayTicket[]): string[] {
  const byOrder = new Map<string, DisplayTicket[]>();
  for (const ticket of tickets) {
    const group = byOrder.get(ticket.orderId) ?? [];
    group.push(ticket);
    byOrder.set(ticket.orderId, group);
  }
  const ready: string[] = [];
  for (const [orderId, group] of byOrder) {
    const relevant = group.filter((t) => t.items.some((i) => !i.voided));
    if (relevant.length > 0 && relevant.every((t) => t.bumped)) ready.push(orderId);
  }
  return ready;
}

/**
 * P3-03: the live kitchen queue — grouped by station, oldest first, with an
 * elapsed timer per ticket (color-coded past 5/10 minutes), bump and recall,
 * and an "orders ready" banner once every station's ticket for an order is
 * bumped. Polls KitchenTicketsTerminalController (device-token auth — the
 * desktop app has no user login) every 5s for the normal, online path.
 *
 * P3-05: also connects to the branch hub (the first real caller of the
 * P2-38/39 relay primitive) and merges in any `kitchen_ticket` entries
 * relayed there — an offline-fired ticket (PosScreen's
 * handleFireToKitchen) has no real server-side order yet, so it only ever
 * exists on the hub until the sale eventually syncs. Bump/recall for a
 * hub-sourced ticket republishes to the hub instead of calling the server
 * API, since there's no real DB row for the server to update. The hub
 * relay never echoes a sender's own update back to it (hub_server.rs), so
 * every hub-side mutation here updates local state immediately rather than
 * waiting to "receive" its own change.
 */
export function App(): ReactElement {
  const [deviceToken, setDeviceToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [actionError, setActionError] = useState<string | null>(null);
  const [hubTickets, setHubTickets] = useState<Map<string, KitchenTicket>>(new Map());
  const hubClientRef = useRef<HubClient | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    invoke<string | null>("get_device_token")
      .then((token) => {
        if (!cancelled) setDeviceToken(token);
      })
      .catch((error: unknown) => {
        if (!cancelled) setTokenError(error instanceof Error ? error.message : "Couldn't read this device's stored token.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), TIMER_TICK_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!deviceToken) return;
    let cancelled = false;

    function applyEntry(entry: StateEntry): void {
      if (entry.entityKind !== KITCHEN_TICKET_ENTITY_KIND) return;
      setHubTickets((tickets) => new Map(tickets).set(entry.entityId, entry.payload as KitchenTicket));
    }

    (async () => {
      const identity = await getDeviceIdentity();
      if (cancelled || !identity?.restaurantId) return;
      const client = await connectToBranchHub(identity.restaurantId, deviceToken, {
        onSnapshot: (entries) => {
          if (cancelled) return;
          setHubTickets((tickets) => {
            const next = new Map(tickets);
            for (const entry of entries) {
              if (entry.entityKind === KITCHEN_TICKET_ENTITY_KIND) next.set(entry.entityId, entry.payload as KitchenTicket);
            }
            return next;
          });
        },
        onUpdate: applyEntry,
      });
      if (cancelled) {
        client?.close();
        return;
      }
      hubClientRef.current = client;
    })().catch(() => {
      // No hub reachable — the online, server-polled path still works on
      // its own; this is purely the LAN relay for offline-fired tickets.
    });

    return () => {
      cancelled = true;
      hubClientRef.current?.close();
      hubClientRef.current = null;
    };
  }, [deviceToken]);

  const ticketsQuery = useQuery({
    queryKey: TICKETS_QUERY_KEY,
    queryFn: () => fetchKitchenTickets(deviceToken!),
    enabled: deviceToken !== null,
    refetchInterval: POLL_INTERVAL_MS,
  });

  const tickets: DisplayTicket[] = useMemo(
    () => [
      ...(ticketsQuery.data ?? []).map((t): DisplayTicket => ({ ...t, source: "server" })),
      ...[...hubTickets.values()].map((t): DisplayTicket => ({ ...t, source: "hub" })),
    ],
    [ticketsQuery.data, hubTickets],
  );

  // P3-04: always print alongside the display (the user's chosen "always
  // both" design) — never conditional on whether the display is "working,"
  // since there is no reliable way to detect that from here anyway. Hub
  // tickets are excluded (they're always printerHost: null — see
  // offline-kitchen-ticket.ts's own docs — so printNewlyFiredTickets would
  // skip them anyway; this just avoids re-scanning them every render).
  useEffect(() => {
    if (ticketsQuery.data) void printNewlyFiredTickets(ticketsQuery.data);
  }, [ticketsQuery.data]);

  const pendingTickets = useMemo(() => tickets.filter((t) => !t.bumped).sort((a, b) => new Date(a.firedAt).getTime() - new Date(b.firedAt).getTime()), [tickets]);
  const recentlyBumped = useMemo(
    () =>
      tickets
        .filter((t) => t.bumped && t.bumpedAt !== null)
        .sort((a, b) => new Date(b.bumpedAt!).getTime() - new Date(a.bumpedAt!).getTime())
        .slice(0, 10),
    [tickets],
  );
  const readyOrders = useMemo(() => readyOrderIds(tickets), [tickets]);

  const stationGroups = useMemo(() => {
    const groups = new Map<string, { stationName: string; tickets: DisplayTicket[] }>();
    for (const ticket of pendingTickets) {
      const key = ticket.stationId ?? "unrouted";
      const group = groups.get(key);
      if (group) group.tickets.push(ticket);
      else groups.set(key, { stationName: ticket.stationName ?? "Unrouted", tickets: [ticket] });
    }
    return [...groups.values()];
  }, [pendingTickets]);

  function republishToHub(ticket: DisplayTicket, bumped: boolean): void {
    const updated: KitchenTicket = { ...ticket, bumped, bumpedAt: bumped ? new Date().toISOString() : null, bumpedByUserId: null };
    const key = ticketKey(ticket);
    setHubTickets((tickets) => new Map(tickets).set(key, updated));
    hubClientRef.current?.send({ entityKind: KITCHEN_TICKET_ENTITY_KIND, entityId: key, version: Date.now(), originDeviceId: "kitchen-display", payload: updated });
  }

  async function handleBump(ticket: DisplayTicket): Promise<void> {
    if (ticket.source === "hub") {
      republishToHub(ticket, true);
      return;
    }
    if (!deviceToken) return;
    setActionError(null);
    try {
      await bumpTicket(deviceToken, ticket);
      await queryClient.invalidateQueries({ queryKey: TICKETS_QUERY_KEY });
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : "Couldn't bump this ticket. Try again.");
    }
  }

  async function handleRecall(ticket: DisplayTicket): Promise<void> {
    if (ticket.source === "hub") {
      republishToHub(ticket, false);
      return;
    }
    if (!deviceToken) return;
    setActionError(null);
    try {
      await recallTicket(deviceToken, ticket);
      await queryClient.invalidateQueries({ queryKey: TICKETS_QUERY_KEY });
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : "Couldn't recall this ticket. Try again.");
    }
  }

  if (tokenError) {
    return <CenteredMessage>{tokenError}</CenteredMessage>;
  }
  if (!deviceToken) {
    return <CenteredMessage>Loading kitchen display…</CenteredMessage>;
  }

  return (
    <div className="flex min-h-screen flex-col gap-4 bg-slate-50 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">Kitchen Display</h1>
        <SyncStatusIndicator />
      </header>

      {readyOrders.length > 0 && (
        <div className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white">
          Ready for service: {readyOrders.map((id) => `#${id.slice(0, 8)}`).join(", ")}
        </div>
      )}
      {ticketsQuery.isError && <div className="rounded-lg bg-red-100 px-4 py-2 text-sm text-red-700">Couldn't load tickets. Retrying…</div>}
      {actionError && <div className="rounded-lg bg-red-100 px-4 py-2 text-sm text-red-700">{actionError}</div>}

      {stationGroups.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-slate-400">No tickets in the queue.</div>
      ) : (
        <div className="flex flex-1 gap-4 overflow-x-auto">
          {stationGroups.map((group) => (
            <div key={group.stationName} className="flex w-72 flex-shrink-0 flex-col gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{group.stationName}</h2>
              {group.tickets.map((ticket) => (
                <TicketCard key={ticketKey(ticket)} ticket={ticket} now={now} onBump={handleBump} />
              ))}
            </div>
          ))}
        </div>
      )}

      {recentlyBumped.length > 0 && (
        <div className="flex gap-2 overflow-x-auto border-t border-slate-200 pt-3">
          <span className="flex-shrink-0 self-center text-xs font-semibold uppercase text-slate-400">Recently bumped</span>
          {recentlyBumped.map((ticket) => (
            <button
              key={ticketKey(ticket)}
              onClick={() => handleRecall(ticket)}
              className="flex-shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs text-slate-600 hover:bg-slate-100"
            >
              #{ticket.orderId.slice(0, 8)} · {ticket.stationName ?? "Unrouted"} · Recall
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TicketCard({ ticket, now, onBump }: { ticket: DisplayTicket; now: number; onBump: (ticket: DisplayTicket) => void }): ReactElement {
  const level = ticketAgeLevel(ticket.firedAt, now);
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-900">#{ticket.orderId.slice(0, 8)}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${AGE_BADGE_CLASSES[level]}`}>{formatElapsed(ticket.firedAt, now)}</span>
      </div>
      {ticket.rush && <div className="mb-2 inline-block rounded bg-red-600 px-2 py-0.5 text-xs font-bold text-white">RUSH</div>}
      <ul className="mb-3 flex flex-col gap-1.5">
        {ticket.items.map((item) => (
          <li key={item.orderItemId} className={item.voided ? "text-sm text-slate-400 line-through" : "text-sm text-slate-800"}>
            <span className="font-medium">
              {item.quantity}× {item.name}
            </span>
            {item.voided && <span className="ml-1 text-xs font-semibold text-red-500 no-underline">VOIDED</span>}
            {item.modifiers.length > 0 && (
              <div className="pl-3 text-xs text-slate-500">{item.modifiers.map((m) => `${m.quantity}× ${m.name}`).join(", ")}</div>
            )}
            {item.notes && <div className="pl-3 text-xs italic text-slate-500">{item.notes}</div>}
            {(item.seatNumber !== null || item.course !== null) && (
              <div className="pl-3 text-xs text-slate-400">
                {item.seatNumber !== null ? `Seat ${item.seatNumber}` : null}
                {item.seatNumber !== null && item.course !== null ? " · " : null}
                {item.course ?? null}
              </div>
            )}
          </li>
        ))}
      </ul>
      <button onClick={() => onBump(ticket)} className="w-full rounded-lg bg-brand-purple px-3 py-2 text-sm font-semibold text-white">
        Bump
      </button>
    </div>
  );
}

function CenteredMessage({ children }: { children: ReactElement | string }): ReactElement {
  return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">{children}</div>;
}
