import { QueryClient } from "@tanstack/react-query";

/** A module-level singleton rather than one created inside a component: auth-store.ts
 * needs to clear it on every session change (see its own comment), and that must be
 * the *same* instance QueryClientProvider in main.tsx renders with. */
export const queryClient = new QueryClient();
