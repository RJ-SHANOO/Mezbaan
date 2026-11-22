import { invoke } from "@tauri-apps/api/core";
import { enqueuePrintJob, type PrinterConnectionConfig } from "../shared/printer-client.js";
import type { KitchenTicket } from "./kitchen-ticket-client.js";

const PRINTER_TIMEOUT_MS = 5000;
const STORAGE_KEY = "kitchen-printed-ticket-keys";

function ticketKey(ticket: Pick<KitchenTicket, "orderId" | "firedAt" | "stationId">): string {
  return `${ticket.orderId}:${ticket.firedAt}:${ticket.stationId ?? "unrouted"}`;
}

interface KitchenTicketContent {
  orderShortId: string;
  stationName: string | null;
  rush: boolean;
  firedAtLabel: string;
  items: Array<{
    name: string;
    quantity: number;
    notes: string | null;
    seatNumber: number | null;
    course: string | null;
    modifiers: Array<{ name: string; quantity: number }>;
    voided: boolean;
  }>;
}

function renderKitchenTicket(content: KitchenTicketContent): Promise<number[]> {
  return invoke<number[]>("render_kitchen_ticket", { content });
}

/**
 * P3-04: prints alongside the display, always (not a conditional fallback —
 * the user chose "always both" so the printed copy is the safety net if the
 * display itself is ever down, rather than trying to detect "is the display
 * actually up" at all). Enqueues one print job (P2-32's persistent, retrying
 * queue) per ticket that has a station with a printer configured and hasn't
 * already been queued by this device — tracked in localStorage, keyed by
 * the same composite identity KitchenTicketsService uses, so a screen
 * reload doesn't reprint the whole 3-hour window. A failed render/enqueue
 * for one ticket is swallowed and retried on the next poll rather than
 * blocking the rest (rule 14).
 */
export async function printNewlyFiredTickets(tickets: KitchenTicket[]): Promise<void> {
  const printed = loadPrintedKeys();
  let changed = false;

  for (const ticket of tickets) {
    if (ticket.printerHost === null || ticket.printerPort === null) continue;
    const key = ticketKey(ticket);
    if (printed.has(key)) continue;

    try {
      const data = await renderKitchenTicket({
        orderShortId: ticket.orderId.slice(0, 8),
        stationName: ticket.stationName,
        rush: ticket.rush,
        firedAtLabel: new Date(ticket.firedAt).toLocaleTimeString(),
        items: ticket.items.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          notes: item.notes,
          seatNumber: item.seatNumber,
          course: item.course,
          modifiers: item.modifiers,
          voided: item.voided,
        })),
      });
      const connection: PrinterConnectionConfig = { kind: "network", host: ticket.printerHost, port: ticket.printerPort, timeoutMs: PRINTER_TIMEOUT_MS };
      await enqueuePrintJob(connection, data);
      printed.add(key);
      changed = true;
    } catch {
      // Leave it unmarked — the next poll will try again.
    }
  }

  if (changed) savePrintedKeys(printed, tickets);
}

function loadPrintedKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? new Set<string>(JSON.parse(raw) as string[]) : new Set<string>();
  } catch {
    return new Set<string>();
  }
}

/** Prunes any key no longer in the fetched (3-hour) window — it'll never be
 * seen again, so there's no reason to keep it in storage forever. */
function savePrintedKeys(keys: Set<string>, currentTickets: KitchenTicket[]): void {
  const currentKeys = new Set(currentTickets.map(ticketKey));
  const pruned = [...keys].filter((k) => currentKeys.has(k));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pruned));
  } catch {
    // Storage full or unavailable — printing already happened; losing the
    // dedup record only risks a duplicate print next poll, never a missed one.
  }
}
