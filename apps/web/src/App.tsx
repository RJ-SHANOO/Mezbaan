import { lazy, Suspense, useEffect, type ReactElement } from "react";
import { useAuthStore } from "./lib/auth-store.js";
import { navigate, useRoute } from "./lib/router.js";

/**
 * P2-42: each screen is its own chunk, loaded only when its own path is
 * actually reached. Section 4 names this one app's eventual audiences as
 * QR menu, public site, Super Admin, and restaurant/branch admin — a
 * handful of very different people who should never have to download
 * each other's screens just because they share a process. Lazy per path
 * (not a routing framework's own code-splitting convention) fits this
 * hand-rolled router's own "grow deliberately" philosophy (lib/router.ts).
 * `.then((m) => ({ default: m.X }))` because every page here is a named
 * export, not a default one — `React.lazy` only accepts the latter.
 */
const LoginPage = lazy(() => import("./pages/LoginPage.js").then((m) => ({ default: m.LoginPage })));
const AcceptInvitePage = lazy(() => import("./pages/AcceptInvitePage.js").then((m) => ({ default: m.AcceptInvitePage })));
const StaffPage = lazy(() => import("./pages/StaffPage.js").then((m) => ({ default: m.StaffPage })));
const BranchesPage = lazy(() => import("./pages/BranchesPage.js").then((m) => ({ default: m.BranchesPage })));

const PUBLIC_PATHS = new Set(["/login", "/accept-invite"]);

function PageLoadingFallback(): ReactElement {
  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-slate-400" role="status">
      Loading…
    </div>
  );
}

export function App(): ReactElement {
  const { path } = useRoute();
  const isAuthenticated = useAuthStore((state) => state.session !== null);

  // Keeps every protected path behind a real redirect, and every known public path
  // reachable directly — the same guard any later module's screens should follow.
  useEffect(() => {
    if (!isAuthenticated && !PUBLIC_PATHS.has(path)) {
      navigate("/login");
    } else if (isAuthenticated && path === "/login") {
      navigate("/branches");
    }
  }, [isAuthenticated, path]);

  return (
    <Suspense fallback={<PageLoadingFallback />}>
      {path === "/accept-invite" ? (
        <AcceptInvitePage />
      ) : !isAuthenticated ? (
        <LoginPage />
      ) : path === "/staff" ? (
        <StaffPage />
      ) : (
        <BranchesPage />
      )}
    </Suspense>
  );
}
