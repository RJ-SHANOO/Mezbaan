import { create } from "zustand";
import { persist } from "zustand/middleware";
import { queryClient } from "./query-client.js";

export interface Session {
  accessToken: string;
  refreshToken: string;
  restaurantSlug: string;
}

interface AuthState {
  session: Session | null;
  setSession: (session: Session) => void;
  clearSession: () => void;
}

/** Persisted to localStorage so a page refresh doesn't log the user out. There's no
 * offline requirement here (this is apps/web, not the POS) — see CLAUDE.md section 4
 * — so plain localStorage persistence is enough; no sync/local-db machinery needed.
 *
 * Every session change clears the query cache here, not in whichever component
 * happens to call setSession/clearSession: logging out, or logging in as a different
 * user without a full page reload (e.g. a shared browser), must never let a later
 * screen render data cached under the previous session — found by hand while testing
 * this exact scenario (owner session's /branches response was still showing after
 * logging in as a cashier who the API correctly 403s). */
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      session: null,
      setSession: (session) => {
        queryClient.clear();
        set({ session });
      },
      clearSession: () => {
        queryClient.clear();
        set({ session: null });
      },
    }),
    { name: "mezbaan-web-auth" },
  ),
);
