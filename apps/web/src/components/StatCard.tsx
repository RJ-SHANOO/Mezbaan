import type { ReactElement, ReactNode } from "react";

export type StatCardTone = "purple" | "teal" | "amber" | "red" | "green" | "blue";

const TONE_BACKGROUND: Record<StatCardTone, string> = {
  purple: "bg-brand-purple",
  teal: "bg-brand-teal",
  amber: "bg-brand-amber",
  red: "bg-brand-red",
  green: "bg-brand-green",
  blue: "bg-brand-blue",
};

export function StatCard({ label, value, icon, tone }: { label: string; value: string | number; icon: ReactNode; tone: StatCardTone }): ReactElement {
  return (
    <div className={`rounded-xl p-5 text-white shadow-sm ${TONE_BACKGROUND[tone]}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-white/85">{label}</p>
          <p className="mt-1 text-2xl font-bold">{value}</p>
        </div>
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/20">{icon}</span>
      </div>
    </div>
  );
}
