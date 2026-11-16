export interface StateEntry {
  entityKind: string;
  entityId: string;
  version: number;
  originDeviceId: string;
  payload: unknown;
}

export type HubConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export interface HubClientHandlers {
  onHello?: (deviceId: string) => void;
  onSnapshot?: (entries: StateEntry[]) => void;
  onUpdate?: (entry: StateEntry) => void;
  /** Fires on every transition, including "reconnecting" after a drop and
   * back to "open" once the hub answers again — a frontend can show
   * something like "hub offline, billing continues locally" (rule 14)
   * directly off this, rather than needing its own retry bookkeeping. */
  onConnectionStateChange?: (state: HubConnectionState) => void;
}

export interface HubClient {
  send(entry: StateEntry): void;
  close(): void;
  getConnectionState(): HubConnectionState;
}

const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;
/** Same reasoning as P1-35's jittered sync backoff: if the hub comes back
 * after an outage, every terminal that was waiting on it shouldn't all
 * reconnect in the exact same instant. */
const JITTER_RATIO = 0.3;

/**
 * P2-38/P2-39: the non-hub side of the branch hub's shared-state relay
 * (hub_server.rs) — connects over the browser's native `WebSocket` API,
 * which is already enough for this role; only the hub itself needs to run
 * Rust server code. `host`/`wsPort` normally come from discovering a hub
 * (P2-37) or a manually entered IP; `deviceToken` is this terminal's own —
 * the hub verifies it offline against its own cached roster (hub_auth.rs),
 * never trusting a connecting client's word for who it is.
 *
 * P2-39's whole point: a hub outage never has to mean a lost update or a
 * frozen terminal. Rule 14 ("a broker/report/printer/external service
 * failure must never block a sale") already holds here by construction —
 * billing goes through `OrdersService`/local SQLite and the real server
 * sync, neither of which this relay touches at all — this module's job is
 * only to make the *convenience* layer (table status, kitchen tickets)
 * resilient too:
 * - **Reconnect with jittered backoff** on any drop, until `close()` is
 *   called deliberately. `getConnectionState()`/`onConnectionStateChange`
 *   let a caller show something like "hub offline" without needing its
 *   own retry bookkeeping.
 * - **An outbox** for anything `send()`'d while disconnected — keyed by
 *   `entityKind:entityId`, so a newer pending update for the same entity
 *   simply replaces an older one rather than queuing both (this relay is
 *   already last-write-wins by `version`, so there's nothing gained by
 *   keeping a stale queued entry around, and this keeps the outbox's size
 *   bounded by distinct entities touched while offline, not by how long
 *   the outage lasted). Flushed in full the moment the socket reopens.
 *
 * Deliberately NOT handled here: a hub whose LAN address changed while it
 * was down (e.g. a new DHCP lease after a reboot) — reconnection targets
 * the same `host`/`wsPort` it was given. A caller that keeps failing to
 * reconnect for an unusually long time is expected to re-run discovery
 * (P2-37) and call `connectToHub` again with a fresh address, rather than
 * this module guessing at a re-discovery policy on its own.
 */
export function connectToHub(host: string, wsPort: number, deviceToken: string, handlers: HubClientHandlers): HubClient {
  let socket: WebSocket | null = null;
  // Seeded to a value distinct from "connecting" on purpose: connect() (called
  // synchronously below) does setState("connecting") as its first real
  // transition, and setState no-ops when the state isn't actually changing —
  // seeding this to "connecting" already would silently swallow that first
  // notification before any handler ever saw it.
  let state: HubConnectionState = "closed";
  let deliberatelyClosed = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const outbox = new Map<string, StateEntry>();

  function setState(next: HubConnectionState): void {
    if (state === next) return;
    state = next;
    handlers.onConnectionStateChange?.(next);
  }

  function outboxKey(entry: StateEntry): string {
    return `${entry.entityKind}:${entry.entityId}`;
  }

  function sendNow(socketToUse: WebSocket, entry: StateEntry): void {
    socketToUse.send(JSON.stringify({ type: "state_update", entry }));
  }

  function flushOutbox(): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    for (const entry of outbox.values()) {
      sendNow(socket, entry);
    }
    outbox.clear();
  }

  function scheduleReconnect(): void {
    if (deliberatelyClosed) return;
    setState("reconnecting");
    const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY_MS);
    const jitter = Math.random() * delay * JITTER_RATIO;
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(connect, delay + jitter);
  }

  function handleMessage(event: MessageEvent<string>): void {
    let message: unknown;
    try {
      message = JSON.parse(event.data);
    } catch {
      return; // not valid JSON — ignore rather than let one bad frame crash this connection
    }
    if (!message || typeof message !== "object" || !("type" in message)) return;

    switch ((message as { type: string }).type) {
      case "hub_hello":
        handlers.onHello?.((message as unknown as { deviceId: string }).deviceId);
        break;
      case "snapshot":
        handlers.onSnapshot?.((message as unknown as { entries: StateEntry[] }).entries);
        break;
      case "state_update":
        handlers.onUpdate?.((message as unknown as { entry: StateEntry }).entry);
        break;
      default:
      // An unrecognized message type — ignore. A future server version may
      // add new message kinds this client doesn't understand yet; that
      // should never be fatal to the connection.
    }
  }

  function connect(): void {
    setState(reconnectAttempt === 0 ? "connecting" : "reconnecting");
    socket = new WebSocket(`ws://${host}:${wsPort}/?token=${encodeURIComponent(deviceToken)}`);

    socket.onopen = () => {
      reconnectAttempt = 0;
      setState("open");
      flushOutbox();
    };
    socket.onmessage = handleMessage;
    socket.onclose = () => {
      if (deliberatelyClosed) {
        setState("closed");
        return;
      }
      scheduleReconnect();
    };
    socket.onerror = () => {
      // onclose fires right after onerror for a failed/dropped connection
      // in every browser WebSocket implementation — reconnection is
      // scheduled there, not duplicated here.
    };
  }

  connect();

  return {
    send(entry: StateEntry): void {
      if (socket && socket.readyState === WebSocket.OPEN) {
        sendNow(socket, entry);
      } else {
        outbox.set(outboxKey(entry), entry);
      }
    },
    close(): void {
      deliberatelyClosed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      socket?.close();
      setState("closed");
    },
    getConnectionState(): HubConnectionState {
      return state;
    },
  };
}
