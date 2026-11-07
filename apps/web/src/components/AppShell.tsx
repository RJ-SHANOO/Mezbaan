import type { ReactElement, ReactNode } from "react";
import { useAuthStore } from "../lib/auth-store.js";
import { navigate, useRoute } from "../lib/router.js";
import { LogoutIcon, StoreIcon, UsersIcon } from "./icons.js";

const NAV_ITEMS = [
  { path: "/branches", label: "Branches", icon: StoreIcon },
  { path: "/staff", label: "Staff", icon: UsersIcon },
];

export function AppShell({ title, children }: { title: string; children: ReactNode }): ReactElement {
  const { path } = useRoute();
  const clearSession = useAuthStore((state) => state.clearSession);
  const restaurantSlug = useAuthStore((state) => state.session?.restaurantSlug);

  function handleLogout(): void {
    clearSession();
    navigate("/login");
  }

  return (
    <div className="flex min-h-screen bg-slate-50">
      <aside className="flex w-64 shrink-0 flex-col bg-gradient-to-b from-[#efeafb] to-[#e2daf7]">
        <div className="flex items-center gap-2 px-6 py-6">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-purple text-base font-bold text-white">M</span>
          <span className="text-lg font-bold text-brand-purple">Mezbaan</span>
        </div>

        <nav className="flex-1 space-y-1 px-3">
          {NAV_ITEMS.map((item) => {
            const isActive = path === item.path;
            return (
              <button
                key={item.path}
                type="button"
                onClick={() => navigate(item.path)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                  isActive ? "bg-white text-brand-purple shadow-sm" : "text-slate-600 hover:bg-white/60"
                }`}
              >
                <item.icon className="h-5 w-5" />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="border-t border-black/5 px-3 py-4">
          <button
            type="button"
            onClick={handleLogout}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-500 transition hover:bg-white/60 hover:text-brand-red"
          >
            <LogoutIcon className="h-5 w-5" />
            Log out
          </button>
        </div>
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-end bg-slate-900 px-6">
          {restaurantSlug && <span className="rounded-full bg-white/10 px-3 py-1 text-sm font-medium text-slate-200">{restaurantSlug}</span>}
        </header>
        <main className="flex-1 px-8 py-6">
          <h1 className="mb-6 text-2xl font-bold text-slate-900">{title}</h1>
          {children}
        </main>
      </div>
    </div>
  );
}
