// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

const checkMock = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({ check: (...args: unknown[]) => checkMock(...args) }));

const { UpdateChecker } = await import("./UpdateChecker.js");

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function renderAndFlush(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<UpdateChecker />);
  });
  // Let the effect's async chain (invoke -> invoke -> check -> maybe install) settle.
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
  checkMock.mockReset();
});

describe("UpdateChecker", () => {
  it("never checks for an update when the device isn't paired yet", async () => {
    invokeMock.mockResolvedValue(null); // get_device_token
    await renderAndFlush();
    expect(checkMock).not.toHaveBeenCalled();
  });

  it("checks with just the device-token header when no rollback is needed", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_device_token") return Promise.resolve("r1.sometoken");
      if (command === "rollback_status") return Promise.resolve({ attempt: 0, shouldRollBack: false, rollbackTargetVersion: null });
      throw new Error(`unexpected command: ${command}`);
    });
    checkMock.mockResolvedValue(null);

    await renderAndFlush();

    expect(checkMock).toHaveBeenCalledWith({ headers: { "X-Device-Token": "r1.sometoken" } });
  });

  it("adds X-Rollback-To-Version when boot-health tracking says this version is bad", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_device_token") return Promise.resolve("r1.sometoken");
      if (command === "rollback_status")
        return Promise.resolve({ attempt: 4, shouldRollBack: true, rollbackTargetVersion: "1.0.0" });
      throw new Error(`unexpected command: ${command}`);
    });
    checkMock.mockResolvedValue(null);

    await renderAndFlush();

    expect(checkMock).toHaveBeenCalledWith({
      headers: { "X-Device-Token": "r1.sometoken", "X-Rollback-To-Version": "1.0.0" },
    });
  });

  it("marks a clean shutdown before downloading and installing an available update", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_device_token") return Promise.resolve("r1.sometoken");
      if (command === "rollback_status") return Promise.resolve({ attempt: 0, shouldRollBack: false, rollbackTargetVersion: null });
      if (command === "mark_clean_shutdown") return Promise.resolve(undefined);
      throw new Error(`unexpected command: ${command}`);
    });
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    checkMock.mockResolvedValue({ version: "2.0.0", downloadAndInstall });

    await renderAndFlush();

    expect(invokeMock).toHaveBeenCalledWith("mark_clean_shutdown");
    expect(downloadAndInstall).toHaveBeenCalled();
  });

  it("does nothing further when no update is available", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_device_token") return Promise.resolve("r1.sometoken");
      if (command === "rollback_status") return Promise.resolve({ attempt: 0, shouldRollBack: false, rollbackTargetVersion: null });
      throw new Error(`unexpected command: ${command}`);
    });
    checkMock.mockResolvedValue(null);

    await expect(renderAndFlush()).resolves.toBeUndefined();
  });
});
