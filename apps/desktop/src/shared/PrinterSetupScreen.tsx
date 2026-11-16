import { useEffect, useState, type ReactElement } from "react";
import {
  clearPrinterConfig,
  getPrintQueueStatus,
  kickCashDrawer,
  listUsbPrinterCandidates,
  loadPrinterConfig,
  printTestPage,
  savePrinterConfig,
  type PrinterConnectionConfig,
  type QueueStatusSummary,
  type UsbDeviceCandidate,
} from "./printer-client.js";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_NETWORK_PORT = 9100;

type TestOutcome = { kind: "idle" } | { kind: "running" } | { kind: "success"; message: string } | { kind: "error"; message: string };

/**
 * P2-35: lets branch staff — not a developer — pick a printer (network IP,
 * or a USB device from what's actually plugged in), test it, and kick the
 * cash drawer, all without touching a config file or a terminal. Closing
 * this screen doesn't lose the choice: `savePrinterConfig` persists it
 * locally (printer_settings.rs) so it's still there next time the app
 * starts.
 */
export function PrinterSetupScreen({ onClose }: { onClose: () => void }): ReactElement {
  const [transport, setTransport] = useState<"network" | "usb">("network");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(String(DEFAULT_NETWORK_PORT));
  const [usbDevices, setUsbDevices] = useState<UsbDeviceCandidate[] | null>(null);
  const [selectedUsbDevice, setSelectedUsbDevice] = useState<UsbDeviceCandidate | null>(null);
  const [scanState, setScanState] = useState<"idle" | "scanning" | "error">("idle");
  const [testOutcome, setTestOutcome] = useState<TestOutcome>({ kind: "idle" });
  const [queueStatus, setQueueStatus] = useState<QueueStatusSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    void loadPrinterConfig()
      .then((config) => {
        if (!config) return;
        setTransport(config.kind);
        if (config.kind === "network") {
          setHost(config.host);
          setPort(String(config.port));
        } else {
          setSelectedUsbDevice({ vendorId: config.vendorId, productId: config.productId, manufacturer: null, product: null });
        }
      })
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)));

    void getPrintQueueStatus()
      .then(setQueueStatus)
      .catch(() => {
        // Queue status is a nice-to-have readout, not core to setup — a
        // failure here shouldn't block the rest of the screen from working.
      });
  }, []);

  function buildConnection(): PrinterConnectionConfig | null {
    if (transport === "network") {
      if (!host.trim()) return null;
      const parsedPort = Number.parseInt(port, 10);
      if (!Number.isInteger(parsedPort) || parsedPort <= 0) return null;
      return { kind: "network", host: host.trim(), port: parsedPort, timeoutMs: DEFAULT_TIMEOUT_MS };
    }
    if (!selectedUsbDevice) return null;
    return { kind: "usb", vendorId: selectedUsbDevice.vendorId, productId: selectedUsbDevice.productId, timeoutMs: DEFAULT_TIMEOUT_MS };
  }

  async function scanUsbDevices(): Promise<void> {
    setScanState("scanning");
    try {
      const devices = await listUsbPrinterCandidates();
      setUsbDevices(devices);
      setScanState("idle");
    } catch {
      setScanState("error");
    }
  }

  async function runTestPrint(): Promise<void> {
    const connection = buildConnection();
    if (!connection) {
      setTestOutcome({ kind: "error", message: "Enter a printer address first." });
      return;
    }
    setTestOutcome({ kind: "running" });
    try {
      await printTestPage(connection);
      setTestOutcome({ kind: "success", message: "Test page sent — check the printer." });
    } catch (error) {
      setTestOutcome({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function runOpenDrawer(): Promise<void> {
    const connection = buildConnection();
    if (!connection) {
      setTestOutcome({ kind: "error", message: "Enter a printer address first." });
      return;
    }
    setTestOutcome({ kind: "running" });
    try {
      await kickCashDrawer(connection);
      setTestOutcome({ kind: "success", message: "Drawer-open signal sent." });
    } catch (error) {
      setTestOutcome({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function handleSave(): Promise<void> {
    const connection = buildConnection();
    if (!connection) {
      setTestOutcome({ kind: "error", message: "Enter a printer address first." });
      return;
    }
    await savePrinterConfig(connection);
    setTestOutcome({ kind: "success", message: "Printer saved." });
  }

  async function handleForget(): Promise<void> {
    await clearPrinterConfig();
    setHost("");
    setPort(String(DEFAULT_NETWORK_PORT));
    setSelectedUsbDevice(null);
    setTestOutcome({ kind: "idle" });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-800">Printer Setup</h2>
          <button type="button" onClick={onClose} className="text-sm text-slate-500 hover:text-slate-700">
            Close
          </button>
        </div>

        {loadError && <p className="mb-3 rounded bg-amber-50 px-3 py-2 text-sm text-amber-700">Couldn't load the saved printer: {loadError}</p>}

        <div className="mb-4 flex gap-2">
          <button
            type="button"
            onClick={() => setTransport("network")}
            className={`flex-1 rounded-lg border px-3 py-2 text-sm ${transport === "network" ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-slate-200 text-slate-600"}`}
          >
            Network Printer
          </button>
          <button
            type="button"
            onClick={() => setTransport("usb")}
            className={`flex-1 rounded-lg border px-3 py-2 text-sm ${transport === "usb" ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-slate-200 text-slate-600"}`}
          >
            USB Printer
          </button>
        </div>

        {transport === "network" ? (
          <div className="mb-4 space-y-2">
            <label className="block text-sm text-slate-600">
              Printer IP address
              <input
                aria-label="Printer IP address"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.50"
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
              />
            </label>
            <label className="block text-sm text-slate-600">
              Port
              <input aria-label="Printer port" value={port} onChange={(e) => setPort(e.target.value)} className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5" />
            </label>
          </div>
        ) : (
          <div className="mb-4 space-y-2">
            <button type="button" onClick={() => void scanUsbDevices()} className="rounded-lg bg-slate-700 px-3 py-1.5 text-sm text-white hover:bg-slate-800">
              {scanState === "scanning" ? "Scanning…" : "Scan for USB devices"}
            </button>
            {scanState === "error" && <p className="text-sm text-red-600">Couldn't scan for USB devices.</p>}
            {usbDevices !== null && usbDevices.length === 0 && <p className="text-sm text-slate-500">No USB devices found. Make sure the printer is plugged in and turned on.</p>}
            {usbDevices !== null && usbDevices.length > 0 && (
              <ul className="max-h-40 space-y-1 overflow-y-auto">
                {usbDevices.map((device) => {
                  const isSelected = selectedUsbDevice?.vendorId === device.vendorId && selectedUsbDevice?.productId === device.productId;
                  const label = device.product ?? device.manufacturer ?? `USB device ${device.vendorId.toString(16)}:${device.productId.toString(16)}`;
                  return (
                    <li key={`${device.vendorId}-${device.productId}`}>
                      <button
                        type="button"
                        onClick={() => setSelectedUsbDevice(device)}
                        className={`w-full rounded border px-2 py-1.5 text-left text-sm ${isSelected ? "border-emerald-500 bg-emerald-50" : "border-slate-200"}`}
                      >
                        {label}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {selectedUsbDevice && <p className="text-sm text-slate-600">Selected: {selectedUsbDevice.product ?? `${selectedUsbDevice.vendorId.toString(16)}:${selectedUsbDevice.productId.toString(16)}`}</p>}
          </div>
        )}

        <div className="mb-4 flex gap-2">
          <button type="button" onClick={() => void runTestPrint()} className="flex-1 rounded-lg bg-emerald-600 px-3 py-2 text-sm text-white hover:bg-emerald-700">
            Test Print
          </button>
          <button type="button" onClick={() => void runOpenDrawer()} className="flex-1 rounded-lg bg-slate-600 px-3 py-2 text-sm text-white hover:bg-slate-700">
            Open Drawer
          </button>
        </div>

        {testOutcome.kind === "running" && <p className="mb-3 text-sm text-slate-500">Sending…</p>}
        {testOutcome.kind === "success" && <p className="mb-3 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{testOutcome.message}</p>}
        {testOutcome.kind === "error" && <p className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">Failed: {testOutcome.message}</p>}

        {queueStatus && (queueStatus.failed > 0 || queueStatus.deadLetter > 0) && (
          <p className="mb-3 rounded bg-amber-50 px-3 py-2 text-sm text-amber-700">
            {queueStatus.deadLetter > 0 ? `${queueStatus.deadLetter} print job(s) failed permanently. ` : ""}
            {queueStatus.failed > 0 ? `${queueStatus.failed} job(s) waiting to retry.` : ""}
          </p>
        )}

        <div className="flex justify-between">
          <button type="button" onClick={() => void handleForget()} className="text-sm text-red-600 hover:text-red-700">
            Forget this printer
          </button>
          <button type="button" onClick={() => void handleSave()} className="rounded-lg bg-slate-800 px-4 py-2 text-sm text-white hover:bg-slate-900">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
