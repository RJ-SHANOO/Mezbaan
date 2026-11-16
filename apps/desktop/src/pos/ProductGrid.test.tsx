// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductGrid } from "./ProductGrid.js";
import type { MenuProduct } from "../shared/menu-client.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const products: MenuProduct[] = [
  { id: "prod-1", categoryId: "cat-1", name: "Cheeseburger", sku: null, barcode: null, imageUrl: null, sortOrder: 0, unitPriceMinor: "1500", currency: "PKR" },
  { id: "prod-2", categoryId: "cat-1", name: "Fries", sku: null, barcode: null, imageUrl: null, sortOrder: 1, unitPriceMinor: null, currency: null },
];

function render(overrides: Partial<{ products: MenuProduct[]; selectedProductId: string | null; onSelect: (id: string) => void; emptyMessage: string }> = {}): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const props = { products, selectedProductId: null, onSelect: vi.fn(), emptyMessage: "No products match.", ...overrides };
  act(() => {
    root?.render(<ProductGrid {...props} />);
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

describe("ProductGrid", () => {
  it("renders a tile per product with its formatted price", () => {
    render();
    expect(container?.textContent).toContain("Cheeseburger");
    expect(container?.textContent).toContain("PKR 15.00");
    expect(container?.textContent).toContain("No price set");
  });

  it("shows the empty message when there are no products", () => {
    render({ products: [] });
    expect(container?.textContent).toContain("No products match.");
    expect(container?.querySelectorAll("[role='listitem']")).toHaveLength(0);
  });

  it("calls onSelect with the product id when a tile is clicked", () => {
    const onSelect = vi.fn();
    render({ onSelect });
    const fries = [...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes("Fries"));
    act(() => {
      fries?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith("prod-2");
  });

  it("marks the selected product as pressed", () => {
    render({ selectedProductId: "prod-1" });
    const cheeseburger = [...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes("Cheeseburger"));
    expect(cheeseburger?.getAttribute("aria-pressed")).toBe("true");
  });
});

/** P2-41: a menu past the virtualization threshold (60) only mounts its
 * visible rows. jsdom has no real layout engine and no ResizeObserver, so
 * both are stubbed here — without them `@tanstack/react-virtual` would
 * either throw (no ResizeObserver) or compute a zero-height viewport and
 * render nothing at all. */
describe("ProductGrid — virtualized (large menus)", () => {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  const manyProducts: MenuProduct[] = Array.from({ length: 120 }, (_, i) => ({
    id: `prod-${i}`,
    categoryId: "cat-1",
    name: `Product ${i}`,
    sku: null,
    barcode: null,
    imageUrl: null,
    sortOrder: i,
    unitPriceMinor: "1000",
    currency: "PKR",
  }));

  const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");

  function stubLayout(): void {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 600 });
  }

  function renderMany(overrides: Partial<{ onSelect: (id: string) => void }> = {}): void {
    stubLayout();
    render({ products: manyProducts, ...overrides });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    // jsdom defines clientHeight on a different prototype by default
    // (HTMLElement.prototype has no own descriptor) — restoring `undefined`
    // deletes our override instead of re-adding a bogus own property.
    if (originalClientHeight) {
      Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
    } else {
      delete (HTMLElement.prototype as Partial<Record<"clientHeight", number>>).clientHeight;
    }
  });

  it("does not mount every product at once", () => {
    renderMany();
    const tiles = container?.querySelectorAll("[role='listitem']") ?? [];
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThan(manyProducts.length);
  });

  it("still renders the first product (within the initial visible window)", () => {
    renderMany();
    expect(container?.textContent).toContain("Product 0");
  });

  it("clicking a visible virtualized tile still calls onSelect correctly", () => {
    const onSelect = vi.fn();
    renderMany({ onSelect });

    const firstTile = [...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes("Product 0"));
    act(() => {
      firstTile?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith("prod-0");
  });
});
