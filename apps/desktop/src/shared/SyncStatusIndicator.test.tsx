// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

const { SyncStatusIndicator } = await import("./SyncStatusIndicator.js");

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function renderAndFlush(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<SyncStatusIndicator />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
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

describe("SyncStatusIndicator", () => {
  it("renders nothing before the first status response resolves", async () => {
    invokeMock.mockReturnValue(new Promise(() => {})); // never resolves
    await renderAndFlush();
    expect(container?.textContent).toBe("");
  });

  it("shows 'Not yet synced' when no sync attempt has happened yet", async () => {
    invokeMock.mockResolvedValue({ pendingCount: 0, lastSuccessfulSyncAt: null, online: null });
    await renderAndFlush();
    expect(container?.textContent).toContain("Not yet synced");
  });

  it("shows Online with the pending count when the last attempt succeeded", async () => {
    invokeMock.mockResolvedValue({ pendingCount: 3, lastSuccessfulSyncAt: "2026-01-01T00:00:00.000Z", online: true });
    await renderAndFlush();
    expect(container?.textContent).toContain("Online");
    expect(container?.textContent).toContain("3 pending");
  });

  it("shows Offline when the last attempt failed to reach the server", async () => {
    invokeMock.mockResolvedValue({ pendingCount: 0, lastSuccessfulSyncAt: "2026-01-01T00:00:00.000Z", online: false });
    await renderAndFlush();
    expect(container?.textContent).toContain("Offline");
  });

  it("omits the pending badge when nothing is pending", async () => {
    invokeMock.mockResolvedValue({ pendingCount: 0, lastSuccessfulSyncAt: null, online: true });
    await renderAndFlush();
    expect(container?.textContent).not.toContain("pending");
  });

  it("logs and keeps rendering nothing when the command fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockRejectedValue(new Error("db unavailable"));
    await renderAndFlush();
    expect(container?.textContent).toBe("");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
