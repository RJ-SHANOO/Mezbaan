import type { ReactElement } from "react";

/** Placeholder: the kitchen display's real screens (ticket queue, timers, bump/
 * recall) are Phase 3 work. P1-18 is only the window + error-boundary
 * infrastructure. Kitchen never receives money fields (rule 18) — worth remembering
 * now, before any real data flows into this window. */
export function App(): ReactElement {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-2 bg-slate-50 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-purple text-xl font-bold text-white">M</span>
      <h1 className="text-xl font-semibold text-slate-900">Kitchen Display</h1>
      <p className="text-sm text-slate-500">The ticket queue lands in Phase 3.</p>
    </div>
  );
}
