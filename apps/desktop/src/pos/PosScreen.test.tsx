// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getMenuCategoriesMock = vi.fn();
const getMenuProductsMock = vi.fn();
const findMenuProductByBarcodeMock = vi.fn();
const syncMenuMock = vi.fn();
const getMenuSyncVersionMock = vi.fn();
const getModifierGroupsForProductMock = vi.fn();
vi.mock("../shared/menu-client.js", () => ({
  getMenuCategories: (...args: unknown[]) => getMenuCategoriesMock(...args),
  getMenuProducts: (...args: unknown[]) => getMenuProductsMock(...args),
  findMenuProductByBarcode: (...args: unknown[]) => findMenuProductByBarcodeMock(...args),
  syncMenu: (...args: unknown[]) => syncMenuMock(...args),
  getMenuSyncVersion: (...args: unknown[]) => getMenuSyncVersionMock(...args),
  getModifierGroupsForProduct: (...args: unknown[]) => getModifierGroupsForProductMock(...args),
}));

const completeOfflineSaleMock = vi.fn();
vi.mock("../shared/offline-sale-client.js", () => ({
  completeOfflineSale: (...args: unknown[]) => completeOfflineSaleMock(...args),
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

// getMenuSyncVersion is called unconditionally on every mount (P2-17's "last
// known version" seed) — give it a harmless default so tests that don't care
// about it don't have to set one themselves on top of their syncMenu mock.
beforeEach(() => {
  getMenuSyncVersionMock.mockResolvedValue(null);
});

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
  getMenuSyncVersionMock.mockReset();
  getModifierGroupsForProductMock.mockReset();
  completeOfflineSaleMock.mockReset();
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

  it("P2-17: shows 'Syncing prices…' while the background sync is in flight, then the fresh version once it resolves", async () => {
    getMenuCategoriesMock.mockResolvedValue([]);
    getMenuProductsMock.mockResolvedValue([]);
    let resolveSync: (version: string) => void = () => {};
    syncMenuMock.mockReturnValue(new Promise<string>((resolve) => (resolveSync = resolve)));

    await renderAndFlush();
    expect(container?.textContent).toContain("Syncing prices…");

    await act(async () => {
      resolveSync("2026-02-02T10:00:00.000Z");
      await Promise.resolve();
    });

    expect(container?.textContent).not.toContain("Syncing prices…");
    expect(container?.textContent).toContain("Prices as of");
  });

  it("P2-17: falls back to the last known price version when this session's sync fails", async () => {
    getMenuCategoriesMock.mockResolvedValue([]);
    getMenuProductsMock.mockResolvedValue([]);
    getMenuSyncVersionMock.mockResolvedValue("2026-01-01T00:00:00.000Z");
    syncMenuMock.mockRejectedValue(new Error("offline"));

    await renderAndFlush();

    expect(container?.textContent).toContain("Prices as of");
  });

  it("P2-17: shows 'Prices not yet synced' when there's no prior version and this session's sync also fails", async () => {
    getMenuCategoriesMock.mockResolvedValue([]);
    getMenuProductsMock.mockResolvedValue([]);
    getMenuSyncVersionMock.mockResolvedValue(null);
    syncMenuMock.mockRejectedValue(new Error("offline"));

    await renderAndFlush();

    expect(container?.textContent).toContain("Prices not yet synced");
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

  it("shows a scan notice, selects the product's category, and adds the scanned item to the cart", async () => {
    getMenuCategoriesMock.mockResolvedValue([{ id: "cat-1", name: "Burgers", sortOrder: 0 }]);
    getMenuProductsMock.mockResolvedValue([]);
    syncMenuMock.mockResolvedValue("v1");
    getModifierGroupsForProductMock.mockResolvedValue([]);
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
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(findMenuProductByBarcodeMock).toHaveBeenCalledWith("1111");
    expect(container?.textContent).toContain("Scanned: Cheeseburger");
    expect(container?.querySelector("[aria-label='Cart']")?.textContent).toContain("Cheeseburger");
  });

  describe("the cart", () => {
    const product = { id: "prod-1", categoryId: "cat-1", name: "Cheeseburger", sku: null, barcode: null, imageUrl: null, sortOrder: 0, unitPriceMinor: "1500", currency: "PKR" };

    it("adds a product with no modifier groups straight to the cart on tap", async () => {
      getMenuCategoriesMock.mockResolvedValue([]);
      getMenuProductsMock.mockResolvedValue([product]);
      syncMenuMock.mockResolvedValue("v1");
      getModifierGroupsForProductMock.mockResolvedValue([]);
      await renderAndFlush();

      const tile = [...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes("Cheeseburger"));
      await act(async () => {
        tile?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const cart = container?.querySelector("[aria-label='Cart']");
      expect(cart?.textContent).toContain("1× Cheeseburger");
      expect(cart?.textContent).toContain("PKR 15.00");
    });

    it("opens the modifier picker for a product with attached groups, and adds the chosen modifier on confirm", async () => {
      getMenuCategoriesMock.mockResolvedValue([]);
      getMenuProductsMock.mockResolvedValue([product]);
      syncMenuMock.mockResolvedValue("v1");
      getModifierGroupsForProductMock.mockResolvedValue([
        {
          id: "grp-1",
          name: "Toppings",
          minSelections: 1,
          maxSelections: 1,
          sortOrder: 0,
          options: [{ id: "opt-1", name: "Extra Cheese", sortOrder: 0, unitPriceMinor: "150", currency: "PKR" }],
        },
      ]);
      await renderAndFlush();

      const tile = [...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes("Cheeseburger"));
      await act(async () => {
        tile?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(container?.querySelector("[role='dialog']")).not.toBeNull();
      // "Add to cart" starts disabled — the required group has nothing selected yet.
      const addButton = [...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Add to cart") as HTMLButtonElement;
      expect(addButton.disabled).toBe(true);

      const checkbox = container?.querySelector("input[type='radio']") as HTMLInputElement;
      await act(async () => {
        checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(addButton.disabled).toBe(false);

      await act(async () => {
        addButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(container?.querySelector("[role='dialog']")).toBeNull();
      const cart = container?.querySelector("[aria-label='Cart']");
      expect(cart?.textContent).toContain("Cheeseburger");
      expect(cart?.textContent).toContain("Extra Cheese");
    });

    it("removes a line from the cart", async () => {
      getMenuCategoriesMock.mockResolvedValue([]);
      getMenuProductsMock.mockResolvedValue([product]);
      syncMenuMock.mockResolvedValue("v1");
      getModifierGroupsForProductMock.mockResolvedValue([]);
      await renderAndFlush();

      const tile = [...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes("Cheeseburger"));
      await act(async () => {
        tile?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const removeButton = container?.querySelector("[aria-label='Remove Cheeseburger from cart']");
      await act(async () => {
        removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(container?.querySelector("[aria-label='Cart']")?.textContent).toContain("Cart is empty.");
    });

    async function addProductToCartViaTap(): Promise<void> {
      const tile = [...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes("Cheeseburger"));
      await act(async () => {
        tile?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    it("completes a sale with the cart's own order type and currency, then clears the cart and shows the document number", async () => {
      getMenuCategoriesMock.mockResolvedValue([]);
      getMenuProductsMock.mockResolvedValue([product]);
      syncMenuMock.mockResolvedValue("v1");
      getModifierGroupsForProductMock.mockResolvedValue([]);
      completeOfflineSaleMock.mockResolvedValue({
        id: "op-1",
        documentNumber: "B1-T1-000001",
        orderType: "dine_in",
        currency: "PKR",
        subtotalMinor: "1500",
        serviceChargeMinor: "0",
        taxBaseMinor: "1500",
        taxMinor: "0",
        totalMinor: "1500",
      });
      await renderAndFlush();
      await addProductToCartViaTap();

      const checkoutButton = container?.querySelector("[aria-label='Checkout']");
      await act(async () => {
        checkoutButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(completeOfflineSaleMock).toHaveBeenCalledWith("dine_in", "PKR", expect.arrayContaining([expect.objectContaining({ productId: "prod-1" })]), expect.any(String));
      const cart = container?.querySelector("[aria-label='Cart']");
      expect(cart?.textContent).toContain("Cart is empty.");
      expect(cart?.textContent).toContain("B1-T1-000001");
    });

    it("shows a readable error and keeps the cart intact when checkout fails", async () => {
      getMenuCategoriesMock.mockResolvedValue([]);
      getMenuProductsMock.mockResolvedValue([product]);
      syncMenuMock.mockResolvedValue("v1");
      getModifierGroupsForProductMock.mockResolvedValue([]);
      completeOfflineSaleMock.mockRejectedValue(new Error("this terminal has no stored branch/terminal number — pair it again"));
      await renderAndFlush();
      await addProductToCartViaTap();

      const checkoutButton = container?.querySelector("[aria-label='Checkout']");
      await act(async () => {
        checkoutButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const cart = container?.querySelector("[aria-label='Cart']");
      expect(cart?.textContent).toContain("pair it again");
      expect(cart?.textContent).toContain("1× Cheeseburger"); // the sale failed, so nothing was cleared
    });
  });
});
