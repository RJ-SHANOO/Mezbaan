import { invoke } from "@tauri-apps/api/core";

export type PrinterConnectionConfig =
  | { kind: "network"; host: string; port: number; timeoutMs: number }
  | { kind: "usb"; vendorId: number; productId: number; timeoutMs: number };

export interface UsbDeviceCandidate {
  vendorId: number;
  productId: number;
  manufacturer: string | null;
  product: string | null;
}

export interface QueueStatusSummary {
  pending: number;
  printing: number;
  failed: number;
  deadLetter: number;
  done: number;
}

/** P2-35: USB devices currently plugged in, for the setup screen's picker. */
export function listUsbPrinterCandidates(): Promise<UsbDeviceCandidate[]> {
  return invoke<UsbDeviceCandidate[]>("list_usb_printer_candidates");
}

/** Sent directly, not queued — an interactive "click it, see the result now" action. */
export function printTestPage(connection: PrinterConnectionConfig): Promise<void> {
  return invoke<void>("print_test_page", { connection });
}

/** P2-34: kicks the drawer wired to this printer's drawer port, same "do it now" reasoning as printTestPage. */
export function kickCashDrawer(connection: PrinterConnectionConfig): Promise<void> {
  return invoke<void>("kick_cash_drawer", { connection, pin: null, onMs: null, offMs: null });
}

export function savePrinterConfig(connection: PrinterConnectionConfig): Promise<void> {
  return invoke<void>("save_printer_config", { json: JSON.stringify(connection) });
}

export async function loadPrinterConfig(): Promise<PrinterConnectionConfig | null> {
  const json = await invoke<string | null>("load_printer_config");
  return json ? (JSON.parse(json) as PrinterConnectionConfig) : null;
}

export function clearPrinterConfig(): Promise<void> {
  return invoke<void>("clear_printer_config");
}

/** P2-32's failure-alert primitive — not polled by anything yet except this setup screen's own status readout. */
export function getPrintQueueStatus(): Promise<QueueStatusSummary> {
  return invoke<QueueStatusSummary>("get_print_queue_status");
}

/** P2-32: hands already-rendered ESC/POS bytes to the persistent, retrying
 * local print queue — never sent directly from the caller. */
export function enqueuePrintJob(connection: PrinterConnectionConfig, data: number[]): Promise<string> {
  return invoke<string>("enqueue_print_job", { connection, data });
}
