import { useEffect, type ReactElement } from "react";
import { useAuthStore } from "./lib/auth-store.js";
import { navigate, useRoute } from "./lib/router.js";
import { AcceptInvitePage } from "./pages/AcceptInvitePage.js";
import { BranchesPage } from "./pages/BranchesPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { StaffPage } from "./pages/StaffPage.js";

const PUBLIC_PATHS = new Set(["/login", "/accept-invite"]);

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

  if (path === "/accept-invite") return <AcceptInvitePage />;
  if (!isAuthenticated) return <LoginPage />;
  if (path === "/staff") return <StaffPage />;
  return <BranchesPage />;
}
