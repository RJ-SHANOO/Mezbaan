// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

const { PairingGate } = await import("./PairingGate.js");

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function renderInto(children: ReactElement): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(children);
  });
  return container;
}

// React wraps the instance's `value` setter for a controlled input differently
// between renders, so a plain `input.value = x` (or redefining an own property)
// doesn't reliably reach its onChange — calling the prototype's native setter
// directly, then dispatching the event, is the standard way around that.
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;

function typeInto(input: HTMLInputElement, value: string): void {
  nativeInputValueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
  invokeMock.mockReset();
  vi.unstubAllGlobals();
});

describe("PairingGate", () => {
  it("renders children once a device token already exists", async () => {
    invokeMock.mockResolvedValue("existing-token");
    const el = await renderInto(
      <PairingGate deviceLabel="POS terminal">
        <p>pos content</p>
      </PairingGate>,
    );
    expect(el.textContent).toContain("pos content");
  });

  it("shows the pairing form, with the device label, when there's no stored token", async () => {
    invokeMock.mockResolvedValue(null);
    const el = await renderInto(
      <PairingGate deviceLabel="kitchen display">
        <p>kitchen content</p>
      </PairingGate>,
    );
    expect(el.textContent).toContain("Pair this kitchen display");
    expect(el.textContent).not.toContain("kitchen content");
  });

  it("redeems a pairing code, stores the returned device token, then renders children", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_device_token") return Promise.resolve(null);
      if (command === "store_device_token") return Promise.resolve(undefined);
      throw new Error(`unexpected command: ${command}`);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            deviceToken: "r1.newtoken",
            device: { id: "11111111-1111-7111-8111-111111111111", branchId: "22222222-2222-7222-8222-222222222222", label: "Front Counter", deviceType: "pos_terminal", status: "active", lastSeenAt: null, createdAt: new Date().toISOString() },
          }),
          { status: 201 },
        ),
      ),
    );

    const el = await renderInto(
      <PairingGate deviceLabel="POS terminal">
        <p>pos content</p>
      </PairingGate>,
    );

    const input = el.querySelector("input");
    const form = el.querySelector("form");
    if (!input || !form) throw new Error("expected the pairing form to be rendered");

    await act(async () => {
      typeInto(input, "a-pairing-code");
    });
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(el.textContent).toContain("pos content");
    expect(invokeMock).toHaveBeenCalledWith("store_device_token", { token: "r1.newtoken" });
  });

  it("shows a readable error when the pairing code is rejected, without storing anything", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_device_token") return Promise.resolve(null);
      throw new Error(`unexpected command: ${command}`);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "Invalid or expired pairing code" }), { status: 401 })),
    );

    const el = await renderInto(
      <PairingGate deviceLabel="POS terminal">
        <p>pos content</p>
      </PairingGate>,
    );

    const input = el.querySelector("input");
    const form = el.querySelector("form");
    if (!input || !form) throw new Error("expected the pairing form to be rendered");

    await act(async () => {
      typeInto(input, "wrong-code");
    });
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(el.textContent).toContain("Invalid or expired pairing code");
    expect(el.textContent).not.toContain("pos content");
    expect(invokeMock).not.toHaveBeenCalledWith("store_device_token", expect.anything());
  });

  it("shows an error state if checking for a stored token itself fails", async () => {
    invokeMock.mockRejectedValue(new Error("keychain unavailable"));
    const el = await renderInto(
      <PairingGate deviceLabel="POS terminal">
        <p>pos content</p>
      </PairingGate>,
    );
    expect(el.textContent).toContain("keychain unavailable");
  });
});
