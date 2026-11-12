// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getMenuCategoriesMock = vi.fn();
const getMenuProductsMock = vi.fn();
const findMenuProductByBarcodeMock = vi.fn();
const syncMenuMock = vi.fn();
vi.mock("../shared/menu-client.js", () => ({
  getMenuCategories: (...args: unknown[]) => getMenuCategoriesMock(...args),
  getMenuProducts: (...args: unknown[]) => getMenuProductsMock(...args),
  findMenuProductByBarcode: (...args: unknown[]) => findMenuProductByBarcodeMock(...args),
  syncMenu: (...args: unknown[]) => syncMenuMock(...args),
}));

const { PosScreen } = await import("./PosScreen.js");

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function renderAndFlush(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient();
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <PosScreen />
      </QueryClientProvider>,
    );
  });
  // A macrotask tick, not just chained microtasks: a rejected queryFn needs an
  // extra hop through React Query's internal state machine before the error
  // state reaches the DOM, and that hop isn't reliably done after only a fixed
  // number of microtask turns on every environment (this flaked in CI once).
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
  getMenuCategoriesMock.mockReset();
  getMenuProductsMock.mockReset();
  findMenuProductByBarcodeMock.mockReset();
  syncMenuMock.mockReset();
});

describe("PosScreen", () => {
  it("renders the synced categories and products", async () => {
    getMenuCategoriesMock.mockResolvedValue([{ id: "cat-1", name: "Burgers", sortOrder: 0 }]);
    getMenuProductsMock.mockResolvedValue([
      { id: "prod-1", categoryId: "cat-1", name: "Cheeseburger", sku: null, barcode: "1111", imageUrl: null, sortOrder: 0, unitPriceMinor: "1500", currency: "PKR" },
    ]);
    syncMenuMock.mockResolvedValue("2026-01-01T00:00:00.000Z");

    await renderAndFlush();

    expect(container?.textContent).toContain("Burgers");
    expect(container?.textContent).toContain("Cheeseburger");
    expect(container?.textContent).toContain("PKR 15.00");
  });

  it("still shows cached data and a note when the background sync fails", async () => {
    getMenuCategoriesMock.mockResolvedValue([]);
    getMenuProductsMock.mockResolvedValue([]);
    syncMenuMock.mockRejectedValue(new Error("offline"));

    await renderAndFlush();

    expect(container?.textContent).toContain("Menu may be out of date");
    expect(container?.textContent).toContain("offline");
  });

  it("shows an error state when the local cache itself can't be read", async () => {
    getMenuCategoriesMock.mockRejectedValue(new Error("db unavailable"));
    getMenuProductsMock.mockRejectedValue(new Error("db unavailable"));
    syncMenuMock.mockResolvedValue("v1");

    await renderAndFlush();

    expect(container?.textContent).toContain("Couldn't load categories from the local cache.");
    expect(container?.textContent).toContain("Couldn't load products from the local cache.");
  });

  it("filters products by the search box", async () => {
    getMenuCategoriesMock.mockResolvedValue([]);
    getMenuProductsMock.mockResolvedValue([]);
    syncMenuMock.mockResolvedValue("v1");
    await renderAndFlush();

    const input = container?.querySelector("input[aria-label='Search products']") as HTMLInputElement;
    // React tracks a controlled input's "last known value" separately from the DOM
    // node's own .value, so setting .value directly (without this native-setter
    // bypass) never triggers its onChange — a well-known jsdom testing gotcha.
    const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      nativeValueSetter?.call(input, "burger");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    expect(getMenuProductsMock).toHaveBeenCalledWith(null, "burger");
  });

  it("shows a scan notice and selects the product's category when a barcode is found", async () => {
    getMenuCategoriesMock.mockResolvedValue([{ id: "cat-1", name: "Burgers", sortOrder: 0 }]);
    getMenuProductsMock.mockResolvedValue([]);
    syncMenuMock.mockResolvedValue("v1");
    findMenuProductByBarcodeMock.mockResolvedValue({
      id: "prod-1",
      categoryId: "cat-1",
      name: "Cheeseburger",
      sku: null,
      barcode: "1111",
      imageUrl: null,
      sortOrder: 0,
      unitPriceMinor: "1500",
      currency: "PKR",
    });
    await renderAndFlush();

    for (const char of "1111") {
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: char }));
      });
    }
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(findMenuProductByBarcodeMock).toHaveBeenCalledWith("1111");
    expect(container?.textContent).toContain("Scanned: Cheeseburger");
  });
});
