// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore, type Session } from "./auth-store.js";
import { queryClient } from "./query-client.js";

const SESSION_A: Session = { accessToken: "token-a", refreshToken: "refresh-a", restaurantSlug: "restaurant-a" };
const SESSION_B: Session = { accessToken: "token-b", refreshToken: "refresh-b", restaurantSlug: "restaurant-b" };

beforeEach(() => {
  localStorage.clear();
  queryClient.clear();
  useAuthStore.setState({ session: null });
});

// Without this, vi.spyOn(queryClient, "clear") in one test wraps the spy left behind
// by a previous test instead of the real method, so a single clearSession() call
// gets counted multiple times in a later test.
afterEach(() => {
  vi.restoreAllMocks();
});

describe("useAuthStore", () => {
  it("setSession stores the session", () => {
    useAuthStore.getState().setSession(SESSION_A);
    expect(useAuthStore.getState().session).toEqual(SESSION_A);
  });

  it("clearSession removes the session", () => {
    useAuthStore.getState().setSession(SESSION_A);
    useAuthStore.getState().clearSession();
    expect(useAuthStore.getState().session).toBeNull();
  });

  it("setSession clears the query cache", () => {
    const clearSpy = vi.spyOn(queryClient, "clear");
    useAuthStore.getState().setSession(SESSION_A);
    expect(clearSpy).toHaveBeenCalledOnce();
  });

  it("clearSession clears the query cache", () => {
    const clearSpy = vi.spyOn(queryClient, "clear");
    useAuthStore.getState().clearSession();
    expect(clearSpy).toHaveBeenCalledOnce();
  });

  // Regression test: found by hand in the browser (not by any automated test) — after
  // logging in as an owner, then logging in as a cashier without a full page reload,
  // the cashier briefly saw the owner's /branches response because the query cache
  // was never cleared on session change. See auth-store.ts's own comment.
  it("switching from one session to another never leaves the previous session's cached data behind", () => {
    useAuthStore.getState().setSession(SESSION_A);
    queryClient.setQueryData(["branches"], [{ id: "1", name: "Owner A's Branch" }]);
    expect(queryClient.getQueryData(["branches"])).toBeDefined();

    useAuthStore.getState().setSession(SESSION_B);

    expect(queryClient.getQueryData(["branches"])).toBeUndefined();
  });

  it("logging out never leaves the session's cached data behind for the next login on a shared browser", () => {
    useAuthStore.getState().setSession(SESSION_A);
    queryClient.setQueryData(["users"], [{ id: "1", displayName: "Someone" }]);

    useAuthStore.getState().clearSession();

    expect(queryClient.getQueryData(["users"])).toBeUndefined();
  });
});
