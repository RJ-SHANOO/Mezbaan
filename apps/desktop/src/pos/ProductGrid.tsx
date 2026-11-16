import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { MenuProduct } from "../shared/menu-client.js";
import { formatPrice } from "./format-price.js";

interface ProductGridProps {
  products: MenuProduct[];
  selectedProductId: string | null;
  onSelect: (productId: string) => void;
  emptyMessage: string;
}

/** Below this, the plain unvirtualized grid (P2-11's original, unchanged)
 * renders every tile directly — virtualization has real overhead of its
 * own (measuring, absolute positioning, a resize listener) that isn't
 * worth paying for a menu small enough to just render outright. Above it,
 * only the visible rows are mounted (P2-41). */
const VIRTUALIZE_THRESHOLD = 60;
const ESTIMATED_ROW_HEIGHT_PX = 96;
/** Mirrors the Tailwind breakpoints the tile grid itself uses below
 * (`sm:grid-cols-3 md:grid-cols-4`) — the virtualizer needs an actual
 * column count to group products into rows, which CSS Grid's own
 * breakpoint-driven auto-flow doesn't expose to JS. */
const SM_BREAKPOINT_PX = 640;
const MD_BREAKPOINT_PX = 768;

function computeColumnCount(): number {
  if (typeof window === "undefined") return 2;
  if (window.innerWidth >= MD_BREAKPOINT_PX) return 4;
  if (window.innerWidth >= SM_BREAKPOINT_PX) return 3;
  return 2;
}

function useColumnCount(): number {
  const [columnCount, setColumnCount] = useState(computeColumnCount);
  useEffect(() => {
    function handleResize(): void {
      setColumnCount(computeColumnCount());
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);
  return columnCount;
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size));
  }
  return rows;
}

function ProductTile({ product, isSelected, onSelect }: { product: MenuProduct; isSelected: boolean; onSelect: (productId: string) => void }): ReactElement {
  return (
    <button
      type="button"
      role="listitem"
      onClick={() => onSelect(product.id)}
      aria-pressed={isSelected}
      className={`flex flex-col items-start gap-1 rounded-lg p-3 text-left transition-colors ${
        isSelected ? "bg-brand-purple text-white" : "bg-white text-slate-700 hover:bg-slate-100"
      }`}
    >
      <span className="text-sm font-medium">{product.name}</span>
      <span className={`text-xs ${isSelected ? "text-white/80" : "text-slate-500"}`}>{formatPrice(product.unitPriceMinor, product.currency)}</span>
    </button>
  );
}

/**
 * P2-11: tapping a tile only highlights it — there's no cart to add it to
 * yet (that's P2-12's job), so a tap or a barcode scan is just a selection
 * affordance for now, not an action with a real effect.
 *
 * P2-41: a menu past `VIRTUALIZE_THRESHOLD` renders only its visible rows
 * (plus a small overscan buffer) via `@tanstack/react-virtual`, grouping
 * products into rows of `columnCount` so a responsive multi-column CSS
 * grid can still be virtualized — the library only windows a single
 * dimension, so each "virtual item" here is one grid row, not one tile.
 */
export function ProductGrid({ products, selectedProductId, onSelect, emptyMessage }: ProductGridProps): ReactElement {
  const columnCount = useColumnCount();
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = chunk(products, columnCount);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT_PX,
    overscan: 4,
  });

  if (products.length === 0) {
    return <p className="py-8 text-center text-sm text-slate-400">{emptyMessage}</p>;
  }

  if (products.length < VIRTUALIZE_THRESHOLD) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4" role="list" aria-label="Products">
        {products.map((product) => (
          <ProductTile key={product.id} product={product} isSelected={selectedProductId === product.id} onSelect={onSelect} />
        ))}
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="h-[70vh] overflow-y-auto" role="list" aria-label="Products">
      <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.key}
            className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4"
            style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)` }}
          >
            {rows[virtualRow.index]!.map((product) => (
              <ProductTile key={product.id} product={product} isSelected={selectedProductId === product.id} onSelect={onSelect} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
