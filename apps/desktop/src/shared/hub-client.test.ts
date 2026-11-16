import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectToHub, type StateEntry } from "./hub-client.js";

const OPEN = 1;
const CLOSED = 3;

/** A minimal fake of the browser's WebSocket, just enough to drive the
 * module under test: records the URL it was constructed with, lets a test
 * trigger onopen/onmessage/onclose, and records what was sent. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  sent: string[] = [];
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = CLOSED;
    this.onclose?.();
  }

  /** Simulates the handshake completing successfully. */
  open(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }

  /** Simulates the connection dropping unexpectedly (not a deliberate close()). */
  drop(): void {
    this.readyState = CLOSED;
    this.onclose?.();
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) } as MessageEvent);
  }
}

function latest(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", Object.assign(FakeWebSocket, { OPEN, CLOSED }));
});

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("connectToHub — connecting and messages", () => {
  it("connects to the right ws:// URL with the token as a query parameter", () => {
    connectToHub("192.168.1.50", 5000, "device-token-123", {});
    expect(latest().url).toBe("ws://192.168.1.50:5000/?token=device-token-123");
  });

  it("URL-encodes a token containing special characters", () => {
    connectToHub("192.168.1.50", 5000, "token/with+special&chars", {});
    expect(latest().url).toContain("token%2Fwith%2Bspecial%26chars");
  });

  it("starts in the connecting state and moves to open once the socket opens", () => {
    const onConnectionStateChange = vi.fn();
    connectToHub("host", 1, "token", { onConnectionStateChange });
    expect(onConnectionStateChange).toHaveBeenCalledWith("connecting");
    latest().open();
    expect(onConnectionStateChange).toHaveBeenCalledWith("open");
  });

  it("calls onHello/onSnapshot/onUpdate for each corresponding message type", () => {
    const onHello = vi.fn();
    const onSnapshot = vi.fn();
    const onUpdate = vi.fn();
    connectToHub("host", 1, "token", { onHello, onSnapshot, onUpdate });
    latest().open();

    latest().emitMessage({ type: "hub_hello", deviceId: "device-5" });
    expect(onHello).toHaveBeenCalledWith("device-5");

    const entries: StateEntry[] = [{ entityKind: "table_status", entityId: "t1", version: 1, originDeviceId: "d1", payload: { status: "occupied" } }];
    latest().emitMessage({ type: "snapshot", entries });
    expect(onSnapshot).toHaveBeenCalledWith(entries);

    const entry: StateEntry = { entityKind: "kitchen_ticket", entityId: "k1", version: 2, originDeviceId: "d2", payload: { status: "fired" } };
    latest().emitMessage({ type: "state_update", entry });
    expect(onUpdate).toHaveBeenCalledWith(entry);
  });

  it("ignores a message with an unrecognized type or invalid JSON rather than throwing", () => {
    const onUpdate = vi.fn();
    connectToHub("host", 1, "token", { onUpdate });
    latest().open();
    expect(() => latest().emitMessage({ type: "something_from_the_future" })).not.toThrow();
    expect(() => latest().emitMessage("not json at all")).not.toThrow();
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

describe("connectToHub — sending and the outbox", () => {
  it("sends immediately when the socket is open", () => {
    const client = connectToHub("host", 1, "token", {});
    latest().open();
    const entry: StateEntry = { entityKind: "order", entityId: "o1", version: 1, originDeviceId: "d1", payload: {} };
    client.send(entry);
    expect(JSON.parse(latest().sent[0]!)).toEqual({ type: "state_update", entry });
  });

  it("queues into the outbox instead of sending while not yet open", () => {
    const client = connectToHub("host", 1, "token", {});
    const entry: StateEntry = { entityKind: "order", entityId: "o1", version: 1, originDeviceId: "d1", payload: {} };
    client.send(entry);
    expect(latest().sent).toHaveLength(0);
  });

  it("flushes the outbox the moment the socket opens", () => {
    const client = connectToHub("host", 1, "token", {});
    const entry: StateEntry = { entityKind: "order", entityId: "o1", version: 1, originDeviceId: "d1", payload: {} };
    client.send(entry);

    latest().open();

    expect(JSON.parse(latest().sent[0]!)).toEqual({ type: "state_update", entry });
  });

  it("a newer queued update for the same entity replaces an older one, rather than sending both", () => {
    const client = connectToHub("host", 1, "token", {});
    client.send({ entityKind: "table_status", entityId: "t1", version: 1, originDeviceId: "d1", payload: { status: "free" } });
    client.send({ entityKind: "table_status", entityId: "t1", version: 2, originDeviceId: "d1", payload: { status: "occupied" } });

    latest().open();

    expect(latest().sent).toHaveLength(1);
    expect(JSON.parse(latest().sent[0]!).entry.version).toBe(2);
  });

  it("queued updates for different entities are all flushed", () => {
    const client = connectToHub("host", 1, "token", {});
    client.send({ entityKind: "table_status", entityId: "t1", version: 1, originDeviceId: "d1", payload: {} });
    client.send({ entityKind: "table_status", entityId: "t2", version: 1, originDeviceId: "d1", payload: {} });

    latest().open();

    expect(latest().sent).toHaveLength(2);
  });
});

describe("connectToHub — reconnection on an unexpected drop", () => {
  beforeEach(() => {
    // Backoff includes random jitter on top of the base delay — pin it to
    // zero so this suite's exact-millisecond assertions are deterministic
    // instead of occasionally flaky depending on what Math.random() rolls.
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  it("moves to reconnecting and opens a new socket after a drop", () => {
    const onConnectionStateChange = vi.fn();
    connectToHub("host", 1, "token", { onConnectionStateChange });
    latest().open();
    onConnectionStateChange.mockClear();

    latest().drop();
    expect(onConnectionStateChange).toHaveBeenCalledWith("reconnecting");

    vi.advanceTimersByTime(5000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("backs off with increasing delay across repeated drops", () => {
    connectToHub("host", 1, "token", {});
    latest().open();

    latest().drop();
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1); // not yet — base delay is ~1000ms
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2);

    latest().drop();
    vi.advanceTimersByTime(1999);
    expect(FakeWebSocket.instances).toHaveLength(2); // second backoff (~2000ms) hasn't elapsed yet
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("resets the backoff after a successful reconnect", () => {
    connectToHub("host", 1, "token", {});
    latest().open();
    latest().drop();
    vi.advanceTimersByTime(2000);
    latest().open(); // successful reconnect — backoff should reset

    latest().drop();
    vi.advanceTimersByTime(1500);
    expect(FakeWebSocket.instances).toHaveLength(3); // base delay again, not the longer second-attempt delay
  });

  it("flushes anything queued while disconnected once the reconnected socket opens", () => {
    const client = connectToHub("host", 1, "token", {});
    latest().open();
    latest().drop();

    client.send({ entityKind: "table_status", entityId: "t1", version: 1, originDeviceId: "d1", payload: {} });

    vi.advanceTimersByTime(2000);
    latest().open();

    expect(latest().sent).toHaveLength(1);
  });
});

describe("connectToHub — deliberate close", () => {
  it("does not attempt to reconnect after close() is called", () => {
    const onConnectionStateChange = vi.fn();
    const client = connectToHub("host", 1, "token", { onConnectionStateChange });
    latest().open();

    client.close();
    expect(onConnectionStateChange).toHaveBeenCalledWith("closed");

    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1); // no reconnect attempt ever made
  });

  it("reports the closed state via getConnectionState()", () => {
    const client = connectToHub("host", 1, "token", {});
    latest().open();
    client.close();
    expect(client.getConnectionState()).toBe("closed");
  });

  it("cancels a pending reconnect timer if close() is called while reconnecting", () => {
    const client = connectToHub("host", 1, "token", {});
    latest().open();
    latest().drop(); // schedules a reconnect

    client.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1); // the scheduled reconnect never fired
  });
});
