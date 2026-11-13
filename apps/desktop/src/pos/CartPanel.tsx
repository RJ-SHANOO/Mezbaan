import type { ReactElement } from "react";
import { cartTotal, lineTotal, type CartLine } from "./cart.js";
import { formatMoney, formatPrice } from "./format-price.js";

interface CartPanelProps {
  lines: CartLine[];
  onRemove: (lineId: string) => void;
}

/** P2-12: the running cart — line items with their modifiers and a total,
 * computed through packages/domain (rule 5), never by hand. */
export function CartPanel({ lines, onRemove }: CartPanelProps): ReactElement {
  const total = cartTotal(lines);

  if (lines.length === 0) {
    return (
      <aside className="flex w-72 flex-col gap-2 rounded-lg bg-white p-3" aria-label="Cart">
        <p className="text-sm text-slate-400">Cart is empty.</p>
      </aside>
    );
  }

  return (
    <aside className="flex w-72 flex-col gap-2 rounded-lg bg-white p-3" aria-label="Cart">
      <ul className="flex flex-col gap-2" role="list">
        {lines.map((line) => (
          <li key={line.lineId} role="listitem" className="flex flex-col gap-1 border-b border-slate-100 pb-2">
            <div className="flex items-start justify-between gap-2">
              <span className="text-sm font-medium text-slate-700">
                {line.quantity}× {line.name}
              </span>
              <button type="button" onClick={() => onRemove(line.lineId)} aria-label={`Remove ${line.name} from cart`} className="text-xs text-red-500 hover:underline">
                Remove
              </button>
            </div>
            {line.modifiers.map((modifier) => (
              <span key={modifier.modifierOptionId} className="pl-3 text-xs text-slate-500">
                + {modifier.name} ({formatPrice(modifier.unitPriceMinor, modifier.currency)})
              </span>
            ))}
            <span className="text-xs text-slate-500">{formatMoney(lineTotal(line))}</span>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between border-t border-slate-200 pt-2 text-sm font-semibold text-slate-800">
        <span>Total</span>
        <span>{total ? formatMoney(total) : "—"}</span>
      </div>
    </aside>
  );
}
