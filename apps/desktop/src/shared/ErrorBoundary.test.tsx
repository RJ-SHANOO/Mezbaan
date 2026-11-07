// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary.js";

// React 19 requires this flag explicitly when a test runner (vitest here, not
// React Testing Library's own jsdom preset) drives act() itself — without it,
// act() still works correctly, but React logs a misleading "not configured to
// support act()" warning on every render.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function ThrowingComponent(): never {
  throw new Error("boom");
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function renderInto(children: ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(children);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
});

describe("ErrorBoundary", () => {
  it("renders its children when nothing throws", () => {
    const el = renderInto(
      <ErrorBoundary module="POS">
        <p>fine</p>
      </ErrorBoundary>,
    );
    expect(el.textContent).toContain("fine");
  });

  it("shows a module-labeled fallback instead of taking down the window when a child throws", () => {
    // React (in dev) logs the thrown error to console.error on top of our own
    // componentDidCatch log — suppressed here to keep test output clean, not to
    // hide a real failure (the test still fails if the fallback doesn't render).
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const el = renderInto(
      <ErrorBoundary module="POS">
        <ThrowingComponent />
      </ErrorBoundary>,
    );

    expect(el.textContent).toContain("POS ran into a problem");
    expect(el.textContent).toContain("boom");
    consoleError.mockRestore();
  });

  it("isolates independent boundaries: Kitchen crashing says Kitchen, not POS", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const el = renderInto(
      <ErrorBoundary module="Kitchen">
        <ThrowingComponent />
      </ErrorBoundary>,
    );

    expect(el.textContent).toContain("Kitchen ran into a problem");
    expect(el.textContent).not.toContain("POS ran into a problem");
    consoleError.mockRestore();
  });
});
