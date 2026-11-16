import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef, type ReactElement } from "react";
import { cartTotal, lineTotal, type CartLine } from "./cart.js";
import { formatMoney, formatPrice } from "./format-price.js";

interface CartPanelProps {
  lines: CartLine[];
  onRemove: (lineId: string) => void;
}

/** Below this, every line renders directly (P2-12's original, unchanged) —
 * a typical order has at most a handful of lines, well under the overhead
 * virtualization would add. Above it (a large banquet/group order), only
 * the visible lines are mounted (P2-41). */
const VIRTUALIZE_THRESHOLD = 40;
const ESTIMATED_LINE_HEIGHT_PX = 72;

function CartLineContent({ line, onRemove }: { line: CartLine; onRemove: (lineId: string) => void }): ReactElement {
  return (
    <>
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
    </>
  );
}

function CartLineRow({ line, onRemove }: { line: CartLine; onRemove: (lineId: string) => void }): ReactElement {
  return (
    <li role="listitem" className="flex flex-col gap-1 border-b border-slate-100 pb-2">
      <CartLineContent line={line} onRemove={onRemove} />
    </li>
  );
}

/** P2-12: the running cart — line items with their modifiers and a total,
 * computed through packages/domain (rule 5), never by hand.
 *
 * P2-41: past `VIRTUALIZE_THRESHOLD` lines, only the visible ones are
 * mounted via `@tanstack/react-virtual`, measuring each line's real
 * rendered height (`measureElement`) rather than assuming a fixed one —
 * a line's height varies with how many modifiers it carries. */
export function CartPanel({ lines, onRemove }: CartPanelProps): ReactElement {
  const total = cartTotal(lines);
  const scrollRef = useRef<HTMLUListElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_LINE_HEIGHT_PX,
    overscan: 6,
  });

  if (lines.length === 0) {
    return (
      <aside className="flex w-72 flex-col gap-2 rounded-lg bg-white p-3" aria-label="Cart">
        <p className="text-sm text-slate-400">Cart is empty.</p>
      </aside>
    );
  }

  const virtualize = lines.length >= VIRTUALIZE_THRESHOLD;

  return (
    <aside className="flex w-72 flex-col gap-2 rounded-lg bg-white p-3" aria-label="Cart">
      {virtualize ? (
        <ul ref={scrollRef} className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto" role="list" style={{ position: "relative", height: rowVirtualizer.getTotalSize() }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const line = lines[virtualRow.index]!;
            return (
              <li
                key={line.lineId}
                role="listitem"
                ref={rowVirtualizer.measureElement}
                data-index={virtualRow.index}
                className="flex flex-col gap-1 border-b border-slate-100 pb-2"
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)` }}
              >
                <CartLineContent line={line} onRemove={onRemove} />
              </li>
            );
          })}
        </ul>
      ) : (
        <ul className="flex flex-col gap-2" role="list">
          {lines.map((line) => (
            <CartLineRow key={line.lineId} line={line} onRemove={onRemove} />
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between border-t border-slate-200 pt-2 text-sm font-semibold text-slate-800">
        <span>Total</span>
        <span>{total ? formatMoney(total) : "—"}</span>
      </div>
    </aside>
  );
}
