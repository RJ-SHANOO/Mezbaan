import type { ReactElement } from "react";
import type { MenuProduct } from "../shared/menu-client.js";
import { formatPrice } from "./format-price.js";

interface ProductGridProps {
  products: MenuProduct[];
  selectedProductId: string | null;
  onSelect: (productId: string) => void;
  emptyMessage: string;
}

/**
 * P2-11: tapping a tile only highlights it — there's no cart to add it to
 * yet (that's P2-12's job), so a tap or a barcode scan is just a selection
 * affordance for now, not an action with a real effect.
 */
export function ProductGrid({ products, selectedProductId, onSelect, emptyMessage }: ProductGridProps): ReactElement {
  if (products.length === 0) {
    return <p className="py-8 text-center text-sm text-slate-400">{emptyMessage}</p>;
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4" role="list" aria-label="Products">
      {products.map((product) => (
        <button
          key={product.id}
          type="button"
          role="listitem"
          onClick={() => onSelect(product.id)}
          aria-pressed={selectedProductId === product.id}
          className={`flex flex-col items-start gap-1 rounded-lg p-3 text-left transition-colors ${
            selectedProductId === product.id ? "bg-brand-purple text-white" : "bg-white text-slate-700 hover:bg-slate-100"
          }`}
        >
          <span className="text-sm font-medium">{product.name}</span>
          <span className={`text-xs ${selectedProductId === product.id ? "text-white/80" : "text-slate-500"}`}>
            {formatPrice(product.unitPriceMinor, product.currency)}
          </span>
        </button>
      ))}
    </div>
  );
}
