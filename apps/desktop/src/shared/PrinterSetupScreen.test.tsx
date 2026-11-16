// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

const { PrinterSetupScreen } = await import("./PrinterSetupScreen.js");

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function renderAndFlush(onClose: () => void = () => {}): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<PrinterSetupScreen onClose={onClose} />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(button: Element | null | undefined): void {
  button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;

async function setInputValue(input: HTMLInputElement | null | undefined, value: string): Promise<void> {
  if (!input) return;
  // Same convention as PosScreen.test.tsx/PairingGate.test.tsx: React
  // patches an instance-level value tracker, so a plain `input.value = x`
  // assignment leaves React believing nothing changed and the subsequent
  // dispatchEvent never reaches onChange. Going through the native
  // prototype setter bypasses that tracker correctly.
  await act(async () => {
    nativeInputValueSetter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function defaultInvoke(overrides: Record<string, unknown> = {}): void {
  invokeMock.mockImplementation((command: string) => {
    if (command === "load_printer_config") return Promise.resolve(overrides.loadPrinterConfig ? JSON.stringify(overrides.loadPrinterConfig) : null);
    if (command === "get_print_queue_status") return Promise.resolve(overrides.getPrintQueueStatus ?? { pending: 0, printing: 0, failed: 0, deadLetter: 0, done: 0 });
    if (command === "list_usb_printer_candidates") return Promise.resolve(overrides.listUsbPrinterCandidates ?? []);
    if (command === "print_test_page") return overrides.printTestPage ?? Promise.resolve(undefined);
    if (command === "kick_cash_drawer") return overrides.kickCashDrawer ?? Promise.resolve(undefined);
    if (command === "save_printer_config") return Promise.resolve(undefined);
    if (command === "clear_printer_config") return Promise.resolve(undefined);
    return Promise.reject(new Error(`unexpected command: ${command}`));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
  invokeMock.mockReset();
});

describe("PrinterSetupScreen", () => {
  it("defaults to the network tab with an empty address", async () => {
    defaultInvoke();
    await renderAndFlush();
    expect(container?.querySelector("input[aria-label='Printer IP address']")).not.toBeNull();
  });

  it("loads and displays a previously saved network printer", async () => {
    defaultInvoke({ loadPrinterConfig: { kind: "network", host: "192.168.1.50", port: 9100, timeoutMs: 5000 } });
    await renderAndFlush();
    const hostInput = container?.querySelector("input[aria-label='Printer IP address']") as HTMLInputElement;
    expect(hostInput.value).toBe("192.168.1.50");
  });

  it("test print requires an address first", async () => {
    defaultInvoke();
    await renderAndFlush();
    const testButton = [...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Test Print");
    click(testButton);
    await flush();
    expect(container?.textContent).toContain("Enter a printer address first");
  });

  it("sends a test print and shows success once an address is entered", async () => {
    defaultInvoke();
    await renderAndFlush();
    await setInputValue(container?.querySelector("input[aria-label='Printer IP address']"), "192.168.1.50");
    const testButton = [...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Test Print");
    click(testButton);
    await flush();
    expect(container?.textContent).toContain("Test page sent");
    expect(invokeMock).toHaveBeenCalledWith("print_test_page", { connection: { kind: "network", host: "192.168.1.50", port: 9100, timeoutMs: 5000 } });
  });

  it("shows an error message when the test print fails", async () => {
    // Pre-handled with a no-op catch: the component attaches its own catch
    // later (once runTestPrint actually awaits it), but Node flags this
    // rejection as unhandled at the next microtask checkpoint otherwise,
    // since nothing has attached a handler to THIS promise instance yet
    // at construction time.
    const rejection = Promise.reject(new Error("printer not found"));
    rejection.catch(() => {});
    defaultInvoke({ printTestPage: rejection });
    await renderAndFlush();
    await setInputValue(container?.querySelector("input[aria-label='Printer IP address']"), "10.0.0.5");
    const testButton = [...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Test Print");
    click(testButton);
    await flush();
    expect(container?.textContent).toContain("Failed: printer not found");
  });

  it("USB scan shows an empty state when nothing is found", async () => {
    defaultInvoke({ listUsbPrinterCandidates: [] });
    await renderAndFlush();
    click([...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "USB Printer"));
    await flush();
    click([...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes("Scan for USB devices")));
    await flush();
    expect(container?.textContent).toContain("No USB devices found");
  });

  it("USB scan lists devices and lets the user select one", async () => {
    defaultInvoke({ listUsbPrinterCandidates: [{ vendorId: 0x04b8, productId: 0x0202, manufacturer: "Epson", product: "TM-T88V" }] });
    await renderAndFlush();
    click([...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "USB Printer"));
    await flush();
    click([...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes("Scan for USB devices")));
    await flush();
    const deviceButton = [...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "TM-T88V");
    expect(deviceButton).not.toBeUndefined();
    click(deviceButton);
    await flush();
    expect(container?.textContent).toContain("Selected: TM-T88V");
  });

  it("shows a failure alert when the print queue has dead-lettered jobs", async () => {
    defaultInvoke({ getPrintQueueStatus: { pending: 1, printing: 0, failed: 2, deadLetter: 3, done: 10 } });
    await renderAndFlush();
    expect(container?.textContent).toContain("3 print job(s) failed permanently");
    expect(container?.textContent).toContain("2 job(s) waiting to retry");
  });

  it("forgetting the printer resets the form", async () => {
    defaultInvoke({ loadPrinterConfig: { kind: "network", host: "192.168.1.50", port: 9100, timeoutMs: 5000 } });
    await renderAndFlush();
    click([...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Forget this printer"));
    await flush();
    const hostInput = container?.querySelector("input[aria-label='Printer IP address']") as HTMLInputElement;
    expect(hostInput.value).toBe("");
    expect(invokeMock).toHaveBeenCalledWith("clear_printer_config");
  });

  it("calls onClose when Close is clicked", async () => {
    defaultInvoke();
    const onClose = vi.fn();
    await renderAndFlush(onClose);
    click([...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Close"));
    expect(onClose).toHaveBeenCalled();
  });
});
