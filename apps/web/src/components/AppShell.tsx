import type { ReactElement, ReactNode } from "react";
import { useAuthStore } from "../lib/auth-store.js";
import { navigate, useRoute } from "../lib/router.js";

const NAV_ITEMS = [
  { path: "/branches", label: "Branches" },
  { path: "/staff", label: "Staff" },
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
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-6">
            <span className="font-semibold text-slate-900">Mezbaan</span>
            <nav className="flex gap-4">
              {NAV_ITEMS.map((item) => (
                <button
                  key={item.path}
                  type="button"
                  onClick={() => navigate(item.path)}
                  className={`text-sm font-medium ${path === item.path ? "text-slate-900" : "text-slate-500 hover:text-slate-700"}`}
                >
                  {item.label}
                </button>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-4 text-sm text-slate-500">
            {restaurantSlug && <span>{restaurantSlug}</span>}
            <button type="button" onClick={handleLogout} className="font-medium text-slate-700 hover:text-slate-900">
              Log out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-6">
        <h1 className="mb-4 text-xl font-semibold text-slate-900">{title}</h1>
        {children}
      </main>
    </div>
  );
}
