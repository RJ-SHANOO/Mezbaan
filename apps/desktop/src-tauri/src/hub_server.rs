//! P2-36: hub mode's two local servers — plain HTTP (tiny_http) and
//! WebSocket (tungstenite) — gated so only a device already present in
//! this branch's cached roster (hub_auth.rs/hub_roster.rs) can connect to
//! anything beyond a bare, unauthenticated health check. Both are plain
//! synchronous servers, matching this crate's existing no-async-runtime
//! style (see Cargo.toml's reqwest comment).
//!
//! `GET /health` needs no token (so P2-37's discovery ping can reach it);
//! every other HTTP path is rejected outright without a token matching the
//! cached roster.
//!
//! P2-37 adds the third background listener `start` spawns: a UDP
//! discovery responder (hub_discovery.rs) so a terminal can find this hub
//! on the local network without anyone typing an IP.
//!
//! P2-38 turns the WebSocket connection from a one-shot handshake proof
//! (P2-36's original "say hello, then close") into a real, persistent
//! relay: once authenticated, a connection stays open, immediately
//! receives a full snapshot of whatever's already shared (hub_state.rs),
//! and from then on both sends and receives `state_update` messages —
//! every update a connected device sends is relayed to every OTHER
//! connected device (never echoed back to its own sender) and persisted,
//! so the hub keeps the branch's current view of orders/table status/
//! kitchen tickets even across its own restart. `HubServerHandle::publish`
//! is the same path for the hub's OWN local changes — it never has to
//! loop a fake connection back to itself.
use crate::hub_auth::{self, RosterEntry};
use crate::hub_discovery::{self, HubIdentityInput};
use crate::hub_state::{self, StateEntry, StateKey};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::http::StatusCode;
use tungstenite::Message;

const POLL_INTERVAL: Duration = Duration::from_millis(100);
/// How long a connection's read call waits for an incoming message before
/// giving up and checking its outgoing queue instead — this is what makes
/// the per-connection loop full-duplex without an async runtime: short
/// enough that a push from another device feels immediate, long enough
/// not to spin the CPU.
const WS_READ_POLL_TIMEOUT: Duration = Duration::from_millis(200);
const DEVICE_TOKEN_HEADER: &str = "x-device-token";
const DEVICE_TOKEN_QUERY_PARAM: &str = "token";

#[derive(Debug)]
pub struct HubServerError(String);

impl fmt::Display for HubServerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "hub server error: {}", self.0)
    }
}

impl std::error::Error for HubServerError {}

pub type SharedRoster = Arc<Mutex<Vec<RosterEntry>>>;
type SharedState = Arc<Mutex<HashMap<StateKey, StateEntry>>>;
type HubDb = Arc<Mutex<Connection>>;
/// One entry per live WebSocket connection: a channel the *other* threads
/// push outgoing frames onto, which this connection's own loop drains and
/// writes — the only way one connection's thread can hand data to
/// another's without both owning the same `WebSocket<TcpStream>`.
type ConnectionRegistry = Arc<Mutex<HashMap<u64, mpsc::Sender<String>>>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RelayMessage {
    #[serde(rename_all = "camelCase")]
    HubHello { device_id: String },
    #[serde(rename_all = "camelCase")]
    Snapshot { entries: Vec<StateEntry> },
    #[serde(rename_all = "camelCase")]
    StateUpdate { entry: StateEntry },
}

pub struct HubServerHandle {
    pub http_port: u16,
    pub ws_port: u16,
    pub discovery_port: u16,
    stop_flag: Arc<AtomicBool>,
    http_thread: Option<JoinHandle<()>>,
    ws_thread: Option<JoinHandle<()>>,
    discovery_thread: Option<JoinHandle<()>>,
    state: SharedState,
    hub_db: HubDb,
    registry: ConnectionRegistry,
}

impl HubServerHandle {
    /// Joins the three fixed listener threads before returning (so the
    /// HTTP/WS/discovery ports are genuinely free again — see
    /// `stopping_the_server_releases_the_port_for_rebinding`), but NOT
    /// every individual per-connection thread: those come and go
    /// dynamically as devices connect/disconnect, so there's no fixed set
    /// of handles to track and join here the way there is for the three
    /// listeners. Each one notices `stop_flag` and closes its own socket
    /// within `WS_READ_POLL_TIMEOUT` of this call, not necessarily before
    /// it returns — an acceptable brief wind-down, not a permanent leak
    /// (see `handle_ws_connection`'s own loop condition).
    pub fn stop(mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(handle) = self.http_thread.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.ws_thread.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.discovery_thread.take() {
            let _ = handle.join();
        }
    }

    /// P2-38: the hub's OWN local change enters the exact same relay path
    /// a remote device's update would — applied to shared state (if
    /// newer), persisted, and broadcast to every connected device. There's
    /// no "originating connection" to exclude here, unlike a remote
    /// update, since this call didn't come from any connection at all.
    /// Returns whether it was actually applied (a stale/duplicate version
    /// is silently dropped, same as from a remote device).
    pub fn publish(&self, entry: StateEntry) -> bool {
        let applied = {
            let mut store = self.state.lock().unwrap();
            hub_state::apply_if_newer(&mut store, entry.clone())
        };
        if applied {
            if let Ok(db) = self.hub_db.lock() {
                let _ = hub_state::persist(&db, &entry);
            }
            broadcast(&self.registry, None, &RelayMessage::StateUpdate { entry });
        }
        applied
    }
}

/// Binds both servers (port 0 lets the OS pick an ephemeral port — useful
/// for tests and for a discovery mechanism that doesn't need a fixed,
/// possibly-already-taken port) plus P2-37's discovery responder, and
/// starts serving all three in background threads. `roster` is a live
/// handle the caller can keep refreshing (hub_roster.rs) — every request
/// re-reads it, so a refresh takes effect on the very next connection with
/// no server restart needed. `discovery_bind_port` is almost always
/// `hub_discovery::DISCOVERY_PORT` in real use; tests pass 0 so parallel
/// test runs don't collide on one fixed UDP port. `initial_state` seeds
/// the live relay from whatever was already persisted (hub_roster's
/// "survive a restart" reasoning, applied to shared state too); `hub_db`
/// is a dedicated connection (db::open_secondary) the relay threads use to
/// persist new updates, independent of the main app's own `DbState`.
pub fn start(
    roster: SharedRoster,
    http_bind_port: u16,
    ws_bind_port: u16,
    identity: HubIdentityInput,
    discovery_bind_port: u16,
    initial_state: HashMap<StateKey, StateEntry>,
    hub_db: Connection,
) -> Result<HubServerHandle, HubServerError> {
    let http_server = tiny_http::Server::http(("127.0.0.1", http_bind_port)).map_err(|e| HubServerError(e.to_string()))?;
    let http_port = http_server.server_addr().to_ip().map(|addr| addr.port()).ok_or_else(|| HubServerError("http server has no IP address".to_string()))?;

    let ws_listener = TcpListener::bind(("127.0.0.1", ws_bind_port)).map_err(|e| HubServerError(e.to_string()))?;
    ws_listener.set_nonblocking(true).map_err(|e| HubServerError(e.to_string()))?;
    let ws_port = ws_listener.local_addr().map_err(|e| HubServerError(e.to_string()))?.port();

    let discovery_socket = hub_discovery::bind_responder_socket(discovery_bind_port).map_err(|e| HubServerError(e.to_string()))?;
    let discovery_port = discovery_socket.local_addr().map_err(|e| HubServerError(e.to_string()))?.port();

    let stop_flag = Arc::new(AtomicBool::new(false));
    let state: SharedState = Arc::new(Mutex::new(initial_state));
    let hub_db: HubDb = Arc::new(Mutex::new(hub_db));
    let registry: ConnectionRegistry = Arc::new(Mutex::new(HashMap::new()));
    let next_connection_id = Arc::new(AtomicU64::new(0));

    let http_stop = stop_flag.clone();
    let http_roster = roster.clone();
    let http_thread = thread::spawn(move || run_http_server(http_server, http_roster, http_stop));

    let ws_stop = stop_flag.clone();
    let ws_roster = roster.clone();
    let ws_state = state.clone();
    let ws_hub_db = hub_db.clone();
    let ws_registry = registry.clone();
    let ws_thread = thread::spawn(move || run_ws_server(ws_listener, ws_roster, ws_state, ws_hub_db, ws_registry, next_connection_id, ws_stop));

    let discovery_stop = stop_flag.clone();
    let full_identity = hub_discovery::HubIdentity {
        device_id: identity.device_id,
        restaurant_id: identity.restaurant_id,
        branch_id: identity.branch_id,
        http_port,
        ws_port,
    };
    let discovery_thread = thread::spawn(move || hub_discovery::serve_responder(discovery_socket, full_identity, discovery_stop));

    Ok(HubServerHandle {
        http_port,
        ws_port,
        discovery_port,
        stop_flag,
        http_thread: Some(http_thread),
        ws_thread: Some(ws_thread),
        discovery_thread: Some(discovery_thread),
        state,
        hub_db,
        registry,
    })
}

fn run_http_server(server: tiny_http::Server, roster: SharedRoster, stop_flag: Arc<AtomicBool>) {
    while !stop_flag.load(Ordering::SeqCst) {
        let Some(request) = server.recv_timeout(POLL_INTERVAL).ok().flatten() else { continue };
        handle_http_request(request, &roster);
    }
}

fn handle_http_request(mut request: tiny_http::Request, roster: &SharedRoster) {
    let is_health_check = request.url() == "/health";

    if !is_health_check {
        let token = request
            .headers()
            .iter()
            .find(|h| h.field.to_string().eq_ignore_ascii_case(DEVICE_TOKEN_HEADER))
            .map(|h| h.value.as_str().to_string());

        let authenticated = token.as_deref().map(|t| hub_auth::authenticate(&roster.lock().unwrap(), t).is_some()).unwrap_or(false);
        if !authenticated {
            let _ = request.respond(tiny_http::Response::empty(401));
            return;
        }
    }

    let _ = request.respond(tiny_http::Response::from_string("ok"));
}

#[allow(clippy::too_many_arguments)]
fn run_ws_server(
    listener: TcpListener,
    roster: SharedRoster,
    state: SharedState,
    hub_db: HubDb,
    registry: ConnectionRegistry,
    next_connection_id: Arc<AtomicU64>,
    stop_flag: Arc<AtomicBool>,
) {
    while !stop_flag.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _addr)) => {
                let roster = roster.clone();
                let state = state.clone();
                let hub_db = hub_db.clone();
                let registry = registry.clone();
                let connection_id = next_connection_id.fetch_add(1, Ordering::SeqCst);
                let connection_stop = stop_flag.clone();
                thread::spawn(move || handle_ws_connection(stream, connection_id, &roster, &state, &hub_db, &registry, &connection_stop));
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(POLL_INTERVAL),
            Err(_) => thread::sleep(POLL_INTERVAL),
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_ws_connection(
    stream: TcpStream,
    connection_id: u64,
    roster: &SharedRoster,
    state: &SharedState,
    hub_db: &HubDb,
    registry: &ConnectionRegistry,
    stop_flag: &Arc<AtomicBool>,
) {
    let auth_roster = roster.clone();
    // tungstenite's accept callback only gets to say accept/reject — it
    // can't hand data back to the caller through its own return type, so
    // the device id the callback determines is stashed here to read once
    // the handshake completes.
    let authenticated_device_id: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let callback_device_id = authenticated_device_id.clone();

    let callback = move |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
        let token = extract_token(request);
        let device_id = token.as_deref().and_then(|t| hub_auth::authenticate(&auth_roster.lock().unwrap(), t));
        match device_id {
            Some(id) => {
                *callback_device_id.lock().unwrap() = Some(id);
                Ok(response)
            }
            None => {
                let mut rejection = ErrorResponse::new(Some("device token invalid or not paired".to_string()));
                *rejection.status_mut() = StatusCode::UNAUTHORIZED;
                Err(rejection)
            }
        }
    };

    let Ok(mut socket) = tungstenite::accept_hdr(stream, callback) else { return };
    let device_id = authenticated_device_id.lock().unwrap().clone().unwrap_or_default();

    // Full-duplex without async: a short read timeout on the underlying
    // stream means `socket.read()` below gives up and returns a
    // would-block-shaped error every WS_READ_POLL_TIMEOUT if the client
    // has sent nothing — which is exactly when this loop also checks its
    // own outgoing queue, so a push from another connection never waits
    // longer than that to go out.
    let _ = socket.get_ref().set_read_timeout(Some(WS_READ_POLL_TIMEOUT));

    let (tx, rx) = mpsc::channel::<String>();
    registry.lock().unwrap().insert(connection_id, tx);

    if send_relay_message(&mut socket, &RelayMessage::HubHello { device_id: device_id.clone() }).is_err() {
        registry.lock().unwrap().remove(&connection_id);
        return;
    }
    let snapshot: Vec<StateEntry> = state.lock().unwrap().values().cloned().collect();
    if send_relay_message(&mut socket, &RelayMessage::Snapshot { entries: snapshot }).is_err() {
        registry.lock().unwrap().remove(&connection_id);
        return;
    }

    // Checked every iteration (same POLL_INTERVAL-shaped cadence as the
    // HTTP/WS accept loops) so stopping the hub doesn't just stop
    // accepting NEW connections — it also closes every already-open one,
    // rather than leaking a thread and a live socket per connection that
    // happened to be open at the moment `stop()` was called.
    while !stop_flag.load(Ordering::SeqCst) {
        while let Ok(outgoing) = rx.try_recv() {
            if socket.send(Message::Text(outgoing.into())).is_err() {
                registry.lock().unwrap().remove(&connection_id);
                return;
            }
        }

        match socket.read() {
            Ok(Message::Text(text)) => {
                if let Ok(RelayMessage::StateUpdate { entry }) = serde_json::from_str::<RelayMessage>(&text) {
                    let applied = hub_state::apply_if_newer(&mut state.lock().unwrap(), entry.clone());
                    if applied {
                        if let Ok(db) = hub_db.lock() {
                            let _ = hub_state::persist(&db, &entry);
                        }
                        broadcast(registry, Some(connection_id), &RelayMessage::StateUpdate { entry });
                    }
                }
            }
            Ok(Message::Close(_)) => {
                registry.lock().unwrap().remove(&connection_id);
                return;
            }
            Ok(_) => {} // ping/pong/binary frames — not part of this protocol, ignored
            Err(tungstenite::Error::Io(ref e)) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                // Nothing arrived within the poll window — normal; loop
                // back around to flush the outgoing queue and try again.
            }
            Err(_) => {
                registry.lock().unwrap().remove(&connection_id);
                return;
            }
        }
    }

    // Loop exited because the hub itself is stopping, not because this
    // connection errored or closed on its own — say goodbye properly.
    let _ = socket.close(None);
    registry.lock().unwrap().remove(&connection_id);
}

fn send_relay_message(socket: &mut tungstenite::WebSocket<TcpStream>, message: &RelayMessage) -> Result<(), ()> {
    let Ok(json) = serde_json::to_string(message) else { return Err(()) };
    socket.send(Message::Text(json.into())).map_err(|_| ())
}

/// Sends `message` to every registered connection except `exclude` (the
/// sender of a remote update, so it never gets its own message echoed
/// back; `None` for a hub-originated publish, which has no sender
/// connection to exclude). A send failure just means that connection is
/// already gone — its own read loop will notice and clean up the registry
/// entry; this function doesn't need to.
fn broadcast(registry: &ConnectionRegistry, exclude: Option<u64>, message: &RelayMessage) {
    let Ok(json) = serde_json::to_string(message) else { return };
    let registry = registry.lock().unwrap();
    for (id, sender) in registry.iter() {
        if Some(*id) == exclude {
            continue;
        }
        let _ = sender.send(json.clone());
    }
}

fn extract_token(request: &Request) -> Option<String> {
    if let Some(header) = request.headers().get(DEVICE_TOKEN_HEADER) {
        if let Ok(value) = header.to_str() {
            return Some(value.to_string());
        }
    }
    let query = request.uri().query()?;
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == DEVICE_TOKEN_QUERY_PARAM).then(|| value.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tungstenite::client::IntoClientRequest;

    fn test_roster() -> SharedRoster {
        Arc::new(Mutex::new(vec![RosterEntry { device_id: "device-1".to_string(), token_hash: hub_auth::hash_token("valid-token") }]))
    }

    fn test_identity() -> HubIdentityInput {
        HubIdentityInput { device_id: "device-1".to_string(), restaurant_id: "restaurant-1".to_string(), branch_id: "branch-1".to_string() }
    }

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../migrations/0009_hub_shared_state.sql")).unwrap();
        conn
    }

    fn start_test_server() -> HubServerHandle {
        start(test_roster(), 0, 0, test_identity(), 0, HashMap::new(), test_db()).unwrap()
    }

    fn connect_ws(ws_port: u16, token: &str) -> tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>> {
        let url = format!("ws://127.0.0.1:{ws_port}/?token={token}");
        tungstenite::connect(url).unwrap().0
    }

    /// Asserts nothing arrives on `socket` within `timeout` — used to prove
    /// a sender never gets its own update echoed back, and that a stale
    /// update is dropped rather than relayed. Reads on a background thread
    /// (rather than trying to set a timeout directly on `MaybeTlsStream`,
    /// whose exact inner-stream API this test suite doesn't need to know)
    /// so the main thread can bound the wait itself via `recv_timeout`.
    fn assert_nothing_arrives_within(mut socket: tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>, timeout: Duration) {
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let _ = tx.send(socket.read());
        });
        assert!(rx.recv_timeout(timeout).is_err(), "expected no message to arrive, but one did");
    }

    #[test]
    fn health_check_needs_no_token() {
        let server = start_test_server();
        let response = reqwest::blocking::get(format!("http://127.0.0.1:{}/health", server.http_port)).unwrap();
        assert_eq!(response.status().as_u16(), 200);
        server.stop();
    }

    #[test]
    fn any_other_path_without_a_token_is_rejected() {
        let server = start_test_server();
        let response = reqwest::blocking::get(format!("http://127.0.0.1:{}/anything", server.http_port)).unwrap();
        assert_eq!(response.status().as_u16(), 401);
        server.stop();
    }

    #[test]
    fn any_other_path_with_a_valid_token_succeeds() {
        let server = start_test_server();
        let client = reqwest::blocking::Client::new();
        let response = client.get(format!("http://127.0.0.1:{}/anything", server.http_port)).header(DEVICE_TOKEN_HEADER, "valid-token").send().unwrap();
        assert_eq!(response.status().as_u16(), 200);
        server.stop();
    }

    #[test]
    fn an_unknown_token_is_rejected_the_same_as_no_token() {
        let server = start_test_server();
        let client = reqwest::blocking::Client::new();
        let response = client.get(format!("http://127.0.0.1:{}/anything", server.http_port)).header(DEVICE_TOKEN_HEADER, "wrong-token").send().unwrap();
        assert_eq!(response.status().as_u16(), 401);
        server.stop();
    }

    #[test]
    fn ws_handshake_with_a_valid_token_in_the_header_also_succeeds() {
        // A native client (unlike a browser's WebSocket API) can set a
        // custom header during the handshake — exercises that path too.
        let server = start_test_server();
        let mut request = format!("ws://127.0.0.1:{}/", server.ws_port).into_client_request().unwrap();
        request.headers_mut().insert(DEVICE_TOKEN_HEADER, "valid-token".parse().unwrap());
        let (mut socket, _response) = tungstenite::connect(request).unwrap();
        let hello = socket.read().unwrap();
        assert_eq!(hello.to_text().unwrap(), r#"{"type":"hub_hello","deviceId":"device-1"}"#);
        server.stop();
    }

    #[test]
    fn ws_handshake_without_a_token_is_rejected() {
        let server = start_test_server();
        let url = format!("ws://127.0.0.1:{}/", server.ws_port);
        let result = tungstenite::connect(url);
        assert!(result.is_err());
        server.stop();
    }

    #[test]
    fn ws_handshake_with_an_unknown_token_is_rejected() {
        let server = start_test_server();
        let url = format!("ws://127.0.0.1:{}/?token=not-a-real-token", server.ws_port);
        let result = tungstenite::connect(url);
        assert!(result.is_err());
        server.stop();
    }

    #[test]
    fn stopping_the_server_releases_the_port_for_rebinding() {
        let server = start_test_server();
        let http_port = server.http_port;
        server.stop();
        // If the listener thread genuinely stopped (rather than just the
        // handle being dropped while the OS socket lingers), a fresh bind
        // on the exact same port should succeed.
        let rebind = TcpListener::bind(("127.0.0.1", http_port));
        assert!(rebind.is_ok());
    }

    #[test]
    fn starting_the_hub_also_makes_it_discoverable_with_its_real_ports() {
        let server = start_test_server();

        let found = hub_discovery::discover_hubs("restaurant-1", server.discovery_port, Duration::from_millis(500)).unwrap();

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].device_id, "device-1");
        assert_eq!(found[0].http_port, server.http_port);
        assert_eq!(found[0].ws_port, server.ws_port);

        server.stop();
    }

    #[test]
    fn a_newly_connecting_client_receives_hello_then_an_empty_snapshot() {
        let server = start_test_server();
        let mut socket = connect_ws(server.ws_port, "valid-token");

        let hello = socket.read().unwrap();
        assert!(hello.to_text().unwrap().contains("hub_hello"));
        let snapshot = socket.read().unwrap();
        assert_eq!(snapshot.to_text().unwrap(), r#"{"type":"snapshot","entries":[]}"#);

        server.stop();
    }

    #[test]
    fn a_newly_connecting_client_receives_whatever_was_already_shared_before_it_connected() {
        let server = start_test_server();
        let entry = StateEntry { entity_kind: "table_status".to_string(), entity_id: "t1".to_string(), version: 1, origin_device_id: "device-1".to_string(), payload: json!({"status": "occupied"}) };
        assert!(server.publish(entry.clone()));

        let mut socket = connect_ws(server.ws_port, "valid-token");
        let _hello = socket.read().unwrap();
        let snapshot_message = socket.read().unwrap();
        let parsed: RelayMessage = serde_json::from_str(snapshot_message.to_text().unwrap()).unwrap();
        match parsed {
            RelayMessage::Snapshot { entries } => assert_eq!(entries, vec![entry]),
            other => panic!("expected a snapshot, got {other:?}"),
        }

        server.stop();
    }

    #[test]
    fn an_update_from_one_connection_is_relayed_to_another_but_not_echoed_back_to_itself() {
        let server = start_test_server();
        let mut sender = connect_ws(server.ws_port, "valid-token");
        let mut receiver = connect_ws(server.ws_port, "valid-token");
        let _ = sender.read().unwrap(); // hello
        let _ = sender.read().unwrap(); // snapshot
        let _ = receiver.read().unwrap(); // hello
        let _ = receiver.read().unwrap(); // snapshot

        let entry = StateEntry { entity_kind: "table_status".to_string(), entity_id: "t1".to_string(), version: 1, origin_device_id: "device-1".to_string(), payload: json!({"status": "occupied"}) };
        let outgoing = serde_json::to_string(&RelayMessage::StateUpdate { entry: entry.clone() }).unwrap();
        sender.send(Message::Text(outgoing.into())).unwrap();

        let received = receiver.read().unwrap();
        let parsed: RelayMessage = serde_json::from_str(received.to_text().unwrap()).unwrap();
        match parsed {
            RelayMessage::StateUpdate { entry: received_entry } => assert_eq!(received_entry, entry),
            other => panic!("expected a state_update, got {other:?}"),
        }

        // The sender itself should NOT receive its own update echoed back.
        assert_nothing_arrives_within(sender, Duration::from_millis(300));

        server.stop();
    }

    #[test]
    fn a_stale_update_from_a_connection_is_dropped_and_never_relayed() {
        let server = start_test_server();
        let newer = StateEntry { entity_kind: "table_status".to_string(), entity_id: "t1".to_string(), version: 5, origin_device_id: "device-1".to_string(), payload: json!({"status": "occupied"}) };
        assert!(server.publish(newer));

        let mut sender = connect_ws(server.ws_port, "valid-token");
        let mut receiver = connect_ws(server.ws_port, "valid-token");
        let _ = sender.read().unwrap();
        let _ = sender.read().unwrap();
        let _ = receiver.read().unwrap();
        let _ = receiver.read().unwrap();

        let stale = StateEntry { entity_kind: "table_status".to_string(), entity_id: "t1".to_string(), version: 2, origin_device_id: "device-1".to_string(), payload: json!({"status": "free"}) };
        let outgoing = serde_json::to_string(&RelayMessage::StateUpdate { entry: stale }).unwrap();
        sender.send(Message::Text(outgoing.into())).unwrap();

        assert_nothing_arrives_within(receiver, Duration::from_millis(300)); // nothing relayed — the stale update was dropped

        server.stop();
    }

    #[test]
    fn publish_applies_persists_and_broadcasts_a_hub_originated_update() {
        let server = start_test_server();
        let mut receiver = connect_ws(server.ws_port, "valid-token");
        let _ = receiver.read().unwrap();
        let _ = receiver.read().unwrap();

        let entry = StateEntry { entity_kind: "kitchen_ticket".to_string(), entity_id: "k1".to_string(), version: 1, origin_device_id: "device-1".to_string(), payload: json!({"status": "fired"}) };
        assert!(server.publish(entry.clone()));

        let received = receiver.read().unwrap();
        let parsed: RelayMessage = serde_json::from_str(received.to_text().unwrap()).unwrap();
        match parsed {
            RelayMessage::StateUpdate { entry: received_entry } => assert_eq!(received_entry, entry),
            other => panic!("expected a state_update, got {other:?}"),
        }

        server.stop();
    }
}
