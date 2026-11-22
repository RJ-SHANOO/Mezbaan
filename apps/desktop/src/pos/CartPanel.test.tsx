// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CartPanel, type CheckoutStatus } from "./CartPanel.js";
import type { CartLine } from "./cart.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function makeLine(overrides: Partial<CartLine> = {}): CartLine {
  return {
    lineId: "line-1",
    productId: "prod-1",
    name: "Cheeseburger",
    quantity: 1,
    unitPriceMinor: "1500",
    currency: "PKR",
    priceListId: "pl-1",
    priceListVersion: 1,
    modifiers: [],
    ...overrides,
  };
}

function render(
  lines: CartLine[],
  onRemove: (lineId: string) => void = vi.fn(),
  onCheckout: () => void = vi.fn(),
  checkoutStatus: CheckoutStatus = { kind: "idle" },
): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <CartPanel
        lines={lines}
        onRemove={onRemove}
        onCheckout={onCheckout}
        checkoutStatus={checkoutStatus}
        firedLineIds={new Set()}
        onFireToKitchen={vi.fn()}
        rush={false}
        onRushChange={vi.fn()}
        hubConnected={false}
      />,
    );
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

describe("CartPanel — small cart (unvirtualized)", () => {
  it("shows the empty state when there are no lines", () => {
    render([]);
    expect(container?.textContent).toContain("Cart is empty.");
  });

  it("renders a line with its quantity, name, modifiers and total", () => {
    render([makeLine({ modifiers: [{ modifierOptionId: "mod-1", name: "Extra Cheese", unitPriceMinor: "100", currency: "PKR", priceListId: "pl-1", priceListVersion: 1 }] })]);
    expect(container?.textContent).toContain("1× Cheeseburger");
    expect(container?.textContent).toContain("Extra Cheese");
  });

  it("calls onRemove with the line id when Remove is clicked", () => {
    const onRemove = vi.fn();
    render([makeLine()], onRemove);
    const removeButton = container?.querySelector("[aria-label='Remove Cheeseburger from cart']");
    act(() => {
      removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRemove).toHaveBeenCalledWith("line-1");
  });

  it("shows the cart total", () => {
    render([makeLine({ unitPriceMinor: "1500" }), makeLine({ lineId: "line-2", name: "Fries", unitPriceMinor: "500" })]);
    expect(container?.textContent).toContain("PKR 20.00");
  });

  it("calls onCheckout when the checkout button is clicked", () => {
    const onCheckout = vi.fn();
    render([makeLine()], vi.fn(), onCheckout);
    const button = container?.querySelector("[aria-label='Checkout']");
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onCheckout).toHaveBeenCalled();
  });

  it("disables the checkout button while a sale is in progress", () => {
    render([makeLine()], vi.fn(), vi.fn(), { kind: "checkingOut" });
    const button = container?.querySelector("[aria-label='Checkout']");
    expect(button?.hasAttribute("disabled")).toBe(true);
    expect(button?.textContent).toContain("Completing sale");
  });

  it("shows the document number and total once a sale succeeds, even though the cart is now empty", () => {
    render([], vi.fn(), vi.fn(), {
      kind: "success",
      invoice: { id: "op-1", documentNumber: "B1-T1-000001", orderType: "dine_in", currency: "PKR", subtotalMinor: "1500", serviceChargeMinor: "0", taxBaseMinor: "1500", taxMinor: "0", totalMinor: "1500" },
    });
    expect(container?.textContent).toContain("B1-T1-000001");
    expect(container?.textContent).toContain("PKR 15.00");
  });

  it("shows a readable error when checkout fails", () => {
    render([makeLine()], vi.fn(), vi.fn(), { kind: "error", message: "this terminal has no stored branch/terminal number — pair it again" });
    expect(container?.textContent).toContain("pair it again");
  });
});

/** P2-41: a cart past the virtualization threshold (40 lines — a large
 * banquet/group order) only mounts its visible rows. jsdom has no real
 * layout engine and no ResizeObserver, so both are stubbed here, same
 * reasoning as ProductGrid's own virtualized tests. */
describe("CartPanel — virtualized (large orders)", () => {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  const manyLines: CartLine[] = Array.from({ length: 80 }, (_, i) => makeLine({ lineId: `line-${i}`, name: `Item ${i}` }));

  function renderMany(onRemove: (lineId: string) => void = vi.fn()): void {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 600 });
    // CartPanel (unlike ProductGrid) measures each row's real rendered height
    // via measureElement, since a line's height varies with its modifier
    // count. With no ResizeObserver entry (the stub above never calls back),
    // @tanstack/virtual-core's default measureElement reads offsetHeight —
    // jsdom has no layout engine, so that's always 0, collapsing every row's
    // measured size and corrupting the virtualized window across re-renders.
    // Stubbing it to the component's own estimate keeps the window stable
    // without changing any production code.
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 72 }); // must match CartPanel's ESTIMATED_LINE_HEIGHT_PX
    render(manyLines, onRemove);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalClientHeight) {
      Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
    } else {
      delete (HTMLElement.prototype as Partial<Record<"clientHeight", number>>).clientHeight;
    }
    if (originalOffsetHeight) {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
    } else {
      delete (HTMLElement.prototype as Partial<Record<"offsetHeight", number>>).offsetHeight;
    }
  });

  it("does not mount every line at once", () => {
    renderMany();
    const items = container?.querySelectorAll("[role='listitem']") ?? [];
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(manyLines.length);
  });

  it("still renders the first line (within the initial visible window)", () => {
    renderMany();
    expect(container?.textContent).toContain("Item 0");
  });

  it("still shows the correct total for every line, not just the visible ones", () => {
    renderMany();
    // 80 lines * PKR 15.00 = PKR 1200.00 — the total is computed over the
    // full `lines` array regardless of how many are actually mounted.
    expect(container?.textContent).toContain("PKR 1200.00");
  });

  it("removing a visible line in the virtualized path still calls onRemove correctly", () => {
    const onRemove = vi.fn();
    renderMany(onRemove);
    const removeButton = container?.querySelector("[aria-label='Remove Item 0 from cart']");
    act(() => {
      removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRemove).toHaveBeenCalledWith("line-0");
  });
});
