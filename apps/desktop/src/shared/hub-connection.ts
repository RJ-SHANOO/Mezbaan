import { invoke } from "@tauri-apps/api/core";
import { connectToHub, type HubClient, type HubClientHandlers } from "./hub-client.js";

interface DiscoveredHub {
  ip: string;
  deviceId: string;
  branchId: string;
  httpPort: number;
  wsPort: number;
}

const DISCOVERY_TIMEOUT_MS = 2000;

/**
 * P3-05: the first real caller of `discover_hubs` (P2-37) and `connectToHub`
 * (P2-38/39) — both existed only as primitives until now. Finds this
 * restaurant's branch hub on the LAN and connects to it as a plain
 * WebSocket client, the same as every device including the hub's own
 * machine (see hub-client.ts's own docs: "only the hub itself needs to run
 * Rust server code" — every device, hub included, is still just a WS
 * client of the relay, so there's no special-casing for "am I the hub").
 *
 * Returns `null` if no hub answered within the timeout — callers must
 * treat that as "no LAN relay available right now," never surface it as an
 * error: kitchen tickets carry no money field (rule 18) and a missing hub
 * must never block a sale (rule 14). The caller still works without one;
 * it just has no way to relay/receive kitchen tickets over the LAN.
 */
export async function connectToBranchHub(restaurantId: string, deviceToken: string, handlers: HubClientHandlers): Promise<HubClient | null> {
  const hubs = await invoke<DiscoveredHub[]>("discover_hubs", { restaurantId, timeoutMs: DISCOVERY_TIMEOUT_MS }).catch(() => []);
  const hub = hubs[0];
  if (!hub) return null;
  return connectToHub(hub.ip, hub.wsPort, deviceToken, handlers);
}
