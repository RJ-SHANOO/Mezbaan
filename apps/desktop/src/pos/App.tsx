import type { ReactElement } from "react";
import { SyncStatusIndicator } from "../shared/SyncStatusIndicator.js";

/** Placeholder: the POS window's actual screens (cart, catalog, payment, ...) are
 * Phase 2 work. P1-18 is only the window + error-boundary infrastructure — this
 * exists so there's something real to boot, crash-test, and build on. */
export function App(): ReactElement {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-2 bg-slate-50 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-purple text-xl font-bold text-white">M</span>
      <h1 className="text-xl font-semibold text-slate-900">POS Terminal</h1>
      <p className="text-sm text-slate-500">Catalog, cart and billing land in Phase 2.</p>
      <SyncStatusIndicator />
    </div>
  );
}
