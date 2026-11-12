// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CategoryGrid } from "./CategoryGrid.js";
import type { MenuCategory } from "../shared/menu-client.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const categories: MenuCategory[] = [
  { id: "cat-1", name: "Burgers", sortOrder: 0 },
  { id: "cat-2", name: "Beverages", sortOrder: 1 },
];

function render(props: { selectedCategoryId: string | null; onSelect: (id: string | null) => void }): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<CategoryGrid categories={categories} {...props} />);
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

describe("CategoryGrid", () => {
  it("renders an 'All' tile plus one tile per category", () => {
    render({ selectedCategoryId: null, onSelect: vi.fn() });
    const items = container?.querySelectorAll("[role='listitem']");
    expect(items).toHaveLength(3);
    expect(container?.textContent).toContain("All");
    expect(container?.textContent).toContain("Burgers");
    expect(container?.textContent).toContain("Beverages");
  });

  it("marks the selected category as pressed", () => {
    render({ selectedCategoryId: "cat-1", onSelect: vi.fn() });
    const burgers = [...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes("Burgers"));
    expect(burgers?.getAttribute("aria-pressed")).toBe("true");
  });

  it("calls onSelect with the category id when a tile is clicked", () => {
    const onSelect = vi.fn();
    render({ selectedCategoryId: null, onSelect });
    const beverages = [...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes("Beverages"));
    act(() => {
      beverages?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith("cat-2");
  });

  it("calls onSelect with null when 'All' is clicked", () => {
    const onSelect = vi.fn();
    render({ selectedCategoryId: "cat-1", onSelect });
    const all = [...(container?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes("All"));
    act(() => {
      all?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});
