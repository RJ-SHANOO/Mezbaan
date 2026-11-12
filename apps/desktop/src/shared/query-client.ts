import { QueryClient } from "@tanstack/react-query";

/** A module-level singleton, same reasoning as apps/web's query-client.ts:
 * it must be the same instance QueryClientProvider renders with. */
export const queryClient = new QueryClient();
