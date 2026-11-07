// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

const { BootHealthReporter } = await import("./BootHealthReporter.js");

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
  invokeMock.mockClear();
});

describe("BootHealthReporter", () => {
  it("confirms boot success on mount and renders nothing", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<BootHealthReporter />);
    });

    expect(invokeMock).toHaveBeenCalledWith("confirm_boot_successful");
    expect(container.textContent).toBe("");
  });

  it("logs rather than throwing when the command fails", async () => {
    invokeMock.mockRejectedValueOnce(new Error("no local database"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<BootHealthReporter />);
    });

    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
