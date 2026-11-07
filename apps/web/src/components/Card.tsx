import type { ReactElement, ReactNode } from "react";

export function Card({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }): ReactElement {
  return (
    <div className="rounded-xl border border-slate-100 bg-white p-5 shadow-sm">
      {(title ?? action) && (
        <div className="mb-4 flex items-center justify-between">
          {title && <h2 className="text-sm font-semibold text-slate-700">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}
