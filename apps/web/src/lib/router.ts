import { useEffect, useState } from "react";

/**
 * A hand-rolled router instead of adding react-router-dom: this app only needs a
 * handful of paths (login, branches, staff, accept-invite), and accept-invite must
 * work as a real bookmarkable/emailable URL (`/accept-invite?token=...`), so *some*
 * path-based routing is necessary — not just nice-to-have. If a later module needs
 * nested routes, params, or guards beyond what this provides, that's the point to
 * reconsider adding a real router rather than growing this file indefinitely.
 */
export function navigate(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): { path: string; searchParams: URLSearchParams } {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPopState = (): void => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return { path, searchParams: new URLSearchParams(window.location.search) };
}
