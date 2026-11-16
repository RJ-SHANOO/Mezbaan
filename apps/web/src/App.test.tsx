// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import { useAuthStore } from "./lib/auth-store.js";
import { queryClient } from "./lib/query-client.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

/** P2-42: each page is a separate lazy-loaded chunk now, so mounting one
 * resolves asynchronously (even though the module is already on disk in a
 * test) — every render here has to actually wait for that promise instead
 * of asserting synchronously, the same two-tick flush already used by
 * SyncStatusIndicator.test.tsx in the desktop app for its own async effects. */
async function renderAt(path: string): Promise<void> {
  window.history.pushState({}, "", path);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );
  });
  // Polls rather than a fixed number of microtask ticks: a cold dynamic
  // import() (the first time any given test in this file touches that
  // particular lazy chunk) can take more than a few microtasks to settle,
  // so a fixed tick count is flaky — this waits until Suspense's fallback
  // is actually gone, capped so a genuinely broken render still fails fast.
  for (let attempt = 0; attempt < 50 && container?.textContent === "Loading…"; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  useAuthStore.getState().clearSession();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
  useAuthStore.getState().clearSession();
  window.history.pushState({}, "", "/");
});

describe("App — lazy-loaded routing", () => {
  it("renders the lazily-loaded LoginPage when visiting a protected path while unauthenticated", async () => {
    await renderAt("/staff");
    expect(container?.textContent).toContain("Sign in to your restaurant");
  });

  it("renders the lazily-loaded AcceptInvitePage regardless of auth state", async () => {
    await renderAt("/accept-invite?token=abc123");
    expect(container?.textContent).toContain("Set up your account");
  });

  it("renders the lazily-loaded StaffPage when authenticated on /staff", async () => {
    act(() => {
      useAuthStore.getState().setSession({ accessToken: "a", refreshToken: "b", restaurantSlug: "acme" });
    });
    await renderAt("/staff");
    expect(container?.textContent).toContain("Staff");
  });

  it("renders the lazily-loaded BranchesPage as the default authenticated screen", async () => {
    act(() => {
      useAuthStore.getState().setSession({ accessToken: "a", refreshToken: "b", restaurantSlug: "acme" });
    });
    await renderAt("/");
    expect(container?.textContent).toContain("Branches");
  });
});
