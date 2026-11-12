// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts, type KeyboardShortcutHandlers } from "./useKeyboardShortcuts.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function TestHarness({ handlers }: { handlers: KeyboardShortcutHandlers }): null {
  useKeyboardShortcuts(handlers);
  return null;
}

function mount(handlers: KeyboardShortcutHandlers): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<TestHarness handlers={handlers} />);
  });
}

function press(key: string, target: EventTarget = window): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
});

function handlers(overrides: Partial<KeyboardShortcutHandlers> = {}): KeyboardShortcutHandlers {
  return {
    categoryCount: 5,
    onSelectCategoryByIndex: vi.fn(),
    onFocusSearch: vi.fn(),
    onClearSearch: vi.fn(),
    ...overrides,
  };
}

describe("useKeyboardShortcuts", () => {
  it("selects a category by digit", () => {
    const h = handlers();
    mount(h);

    press("3");

    expect(h.onSelectCategoryByIndex).toHaveBeenCalledWith(2);
  });

  it("ignores a digit beyond how many categories exist", () => {
    const h = handlers({ categoryCount: 2 });
    mount(h);

    press("5");

    expect(h.onSelectCategoryByIndex).not.toHaveBeenCalled();
  });

  it("focuses search on '/'", () => {
    const h = handlers();
    mount(h);

    press("/");

    expect(h.onFocusSearch).toHaveBeenCalled();
  });

  it("clears search on Escape, even from inside an input", () => {
    const h = handlers();
    mount(h);
    const input = document.createElement("input");
    container?.appendChild(input);

    press("Escape", input);

    expect(h.onClearSearch).toHaveBeenCalled();
  });

  it("does not select a category by digit while an input has focus", () => {
    const h = handlers();
    mount(h);
    const input = document.createElement("input");
    container?.appendChild(input);

    press("3", input);

    expect(h.onSelectCategoryByIndex).not.toHaveBeenCalled();
  });

  it("does not steal '/' from an input that has focus", () => {
    const h = handlers();
    mount(h);
    const input = document.createElement("input");
    container?.appendChild(input);

    press("/", input);

    expect(h.onFocusSearch).not.toHaveBeenCalled();
  });
});
