// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBarcodeScanner } from "./useBarcodeScanner.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function TestHarness({ onScan }: { onScan: (code: string) => void }): null {
  useBarcodeScanner(onScan);
  return null;
}

function mount(onScan: (code: string) => void): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<TestHarness onScan={onScan} />);
  });
}

function typeKey(key: string, atMs: number): void {
  vi.setSystemTime(atMs);
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key }));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
  vi.useRealTimers();
});

describe("useBarcodeScanner", () => {
  it("reports a scan when a burst of keys arrives quickly, followed by Enter", () => {
    vi.useFakeTimers();
    const onScan = vi.fn();
    mount(onScan);

    let t = 1_000;
    for (const char of "12345") {
      typeKey(char, t);
      t += 10; // well under the burst threshold
    }
    typeKey("Enter", t);

    expect(onScan).toHaveBeenCalledWith("12345");
  });

  it("does not report a scan for slow, human-paced typing", () => {
    vi.useFakeTimers();
    const onScan = vi.fn();
    mount(onScan);

    let t = 1_000;
    for (const char of "123") {
      typeKey(char, t);
      t += 300; // well over the burst threshold — a person typing
    }
    typeKey("Enter", t);

    expect(onScan).not.toHaveBeenCalled();
  });

  it("does not report a scan for a burst shorter than the minimum barcode length", () => {
    vi.useFakeTimers();
    const onScan = vi.fn();
    mount(onScan);

    typeKey("1", 1_000);
    typeKey("2", 1_010);
    typeKey("Enter", 1_020);

    expect(onScan).not.toHaveBeenCalled();
  });

  it("ignores modifier and arrow keys without breaking the burst", () => {
    vi.useFakeTimers();
    const onScan = vi.fn();
    mount(onScan);

    let t = 1_000;
    for (const char of "AB12") {
      typeKey(char, t);
      t += 10;
    }
    typeKey("Shift", t);
    t += 10;
    for (const char of "34") {
      typeKey(char, t);
      t += 10;
    }
    typeKey("Enter", t);

    expect(onScan).toHaveBeenCalledWith("AB1234");
  });

  it("stops listening after unmount", () => {
    vi.useFakeTimers();
    const onScan = vi.fn();
    mount(onScan);
    act(() => {
      root?.unmount();
    });

    typeKey("1", 1_000);
    typeKey("2", 1_010);
    typeKey("3", 1_020);
    typeKey("Enter", 1_030);

    expect(onScan).not.toHaveBeenCalled();
  });
});
