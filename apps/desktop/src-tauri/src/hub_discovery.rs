//! P2-37: finding a branch hub (P2-36) on the local network without anyone
//! typing an IP address, with a manual IP as the fallback when broadcast
//! doesn't reach it (different subnet, broadcast blocked by a managed
//! switch/router — common on real restaurant networks). A fixed UDP port
//! carries a tiny broadcast request/reply protocol; everything else about
//! the hub (its actual HTTP/WS ports, whether a given device token is
//! valid) is still gated exactly as P2-36 already built.
//!
//! Scoped to discovery only, same as the rest of this crate's hardware/
//! infra primitives — no frontend screen calls any of this yet, since
//! there's still nothing real to connect *to* until P2-38 defines what a
//! hub connection is actually for.
use serde::{Deserialize, Serialize};
use std::fmt;
use std::net::UdpSocket;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The well-known port every hub listens for discovery requests on.
/// Deliberately separate from the HTTP/WS ports (P2-36), which are
/// per-install and can be anything, including OS-assigned — a terminal
/// has to know exactly one fixed thing to start looking.
pub const DISCOVERY_PORT: u16 = 47999;

const REQUEST_MAGIC: &str = "MEZBAAN_HUB_DISCOVER:";
const REPLY_MAGIC: &str = "MEZBAAN_HUB_HERE:";
const RECV_BUFFER_SIZE: usize = 2048;
const RESPONDER_POLL_TIMEOUT: Duration = Duration::from_millis(200);
const DISCOVERER_POLL_TIMEOUT: Duration = Duration::from_millis(200);

#[derive(Debug)]
pub struct DiscoveryError(String);

impl fmt::Display for DiscoveryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "hub discovery error: {}", self.0)
    }
}

impl std::error::Error for DiscoveryError {}

impl From<std::io::Error> for DiscoveryError {
    fn from(e: std::io::Error) -> Self {
        DiscoveryError(e.to_string())
    }
}

/// What the hub itself knows about its own identity — supplied by the
/// caller (hub_commands.rs, which gets it from the frontend's own
/// `/devices/me` lookup); this module never derives it on its own.
#[derive(Debug, Clone)]
pub struct HubIdentityInput {
    pub device_id: String,
    pub restaurant_id: String,
    pub branch_id: String,
}

/// The full broadcast payload — identity plus the real, already-bound
/// HTTP/WS ports (P2-36), since those are only known once hub_server::start
/// has actually bound them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubIdentity {
    pub device_id: String,
    pub restaurant_id: String,
    pub branch_id: String,
    pub http_port: u16,
    pub ws_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveryRequestPayload {
    restaurant_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredHub {
    pub ip: String,
    pub device_id: String,
    pub branch_id: String,
    pub http_port: u16,
    pub ws_port: u16,
}

/// Binds the responder's UDP socket. Separated from `serve_responder` so
/// the caller (hub_server::start) can read back the actual bound port
/// before handing the socket off to a background thread — same "bind here,
/// serve in a spawned thread" shape as the HTTP/WS listeners.
pub fn bind_responder_socket(port: u16) -> Result<UdpSocket, DiscoveryError> {
    let socket = UdpSocket::bind(("0.0.0.0", port))?;
    socket.set_read_timeout(Some(RESPONDER_POLL_TIMEOUT))?;
    Ok(socket)
}

/// Runs until `stop_flag` is set, replying only to a request scoped to this
/// hub's own `restaurant_id` — a foreign restaurant's terminal broadcasting
/// on the same physical LAN (a shared building, say) gets no reply at all,
/// same tenant-isolation instinct as everywhere else in this codebase, even
/// though this is just a discovery hint and carries nothing sensitive.
/// Malformed or unrelated UDP traffic on this port is silently ignored,
/// never allowed to panic the thread.
pub fn serve_responder(socket: UdpSocket, identity: HubIdentity, stop_flag: Arc<AtomicBool>) {
    let mut buf = [0u8; RECV_BUFFER_SIZE];
    while !stop_flag.load(Ordering::SeqCst) {
        match socket.recv_from(&mut buf) {
            Ok((len, src)) => {
                if let Some(request) = parse_request(&buf[..len]) {
                    if request.restaurant_id == identity.restaurant_id {
                        if let Some(reply) = build_reply(&identity) {
                            let _ = socket.send_to(reply.as_bytes(), src);
                        }
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => {}
        }
    }
}

fn parse_request(bytes: &[u8]) -> Option<DiscoveryRequestPayload> {
    let text = std::str::from_utf8(bytes).ok()?;
    let json = text.strip_prefix(REQUEST_MAGIC)?;
    serde_json::from_str(json).ok()
}

fn build_reply(identity: &HubIdentity) -> Option<String> {
    let json = serde_json::to_string(identity).ok()?;
    Some(format!("{REPLY_MAGIC}{json}"))
}

fn parse_reply(bytes: &[u8]) -> Option<HubIdentity> {
    let text = std::str::from_utf8(bytes).ok()?;
    let json = text.strip_prefix(REPLY_MAGIC)?;
    serde_json::from_str(json).ok()
}

/// Broadcasts one discovery request scoped to `restaurant_id` to
/// `target_port`, then collects replies for `timeout` — a terminal's side
/// of the protocol. `target_port` is a parameter (not hardcoded to
/// `DISCOVERY_PORT`) purely so tests can point it at whatever ephemeral
/// port a test responder actually bound to; real callers always pass
/// `DISCOVERY_PORT`. Results are deduplicated by (ip, httpPort) in case
/// more than one network interface delivers the same hub's reply twice.
pub fn discover_hubs(restaurant_id: &str, target_port: u16, timeout: Duration) -> Result<Vec<DiscoveredHub>, DiscoveryError> {
    let socket = UdpSocket::bind(("0.0.0.0", 0))?;
    socket.set_broadcast(true)?;
    socket.set_read_timeout(Some(DISCOVERER_POLL_TIMEOUT))?;

    let request_json = serde_json::to_string(&DiscoveryRequestPayload { restaurant_id: restaurant_id.to_string() }).map_err(|e| DiscoveryError(e.to_string()))?;
    let request = format!("{REQUEST_MAGIC}{request_json}");
    socket.send_to(request.as_bytes(), ("255.255.255.255", target_port))?;

    let deadline = Instant::now() + timeout;
    let mut found: Vec<DiscoveredHub> = Vec::new();
    let mut buf = [0u8; RECV_BUFFER_SIZE];
    while Instant::now() < deadline {
        match socket.recv_from(&mut buf) {
            Ok((len, src)) => {
                if let Some(identity) = parse_reply(&buf[..len]) {
                    if identity.restaurant_id == restaurant_id {
                        let ip = src.ip().to_string();
                        if !found.iter().any(|hub| hub.ip == ip && hub.http_port == identity.http_port) {
                            found.push(DiscoveredHub { ip, device_id: identity.device_id, branch_id: identity.branch_id, http_port: identity.http_port, ws_port: identity.ws_port });
                        }
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => {}
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    fn identity(restaurant_id: &str) -> HubIdentity {
        HubIdentity { device_id: "device-1".to_string(), restaurant_id: restaurant_id.to_string(), branch_id: "branch-1".to_string(), http_port: 4000, ws_port: 4001 }
    }

    fn spawn_responder(restaurant_id: &str) -> (u16, Arc<AtomicBool>, thread::JoinHandle<()>) {
        let socket = bind_responder_socket(0).unwrap();
        let port = socket.local_addr().unwrap().port();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let thread_stop = stop_flag.clone();
        let id = identity(restaurant_id);
        let handle = thread::spawn(move || serve_responder(socket, id, thread_stop));
        (port, stop_flag, handle)
    }

    #[test]
    fn request_reply_round_trip_parses_correctly() {
        let request = format!("{REQUEST_MAGIC}{}", serde_json::to_string(&DiscoveryRequestPayload { restaurant_id: "r1".to_string() }).unwrap());
        let parsed = parse_request(request.as_bytes()).unwrap();
        assert_eq!(parsed.restaurant_id, "r1");

        let reply = build_reply(&identity("r1")).unwrap();
        let parsed_reply = parse_reply(reply.as_bytes()).unwrap();
        assert_eq!(parsed_reply.device_id, "device-1");
        assert_eq!(parsed_reply.http_port, 4000);
    }

    #[test]
    fn ignores_garbage_that_isnt_the_discovery_protocol_at_all() {
        assert!(parse_request(b"not our protocol").is_none());
        assert!(parse_reply(b"not our protocol").is_none());
    }

    #[test]
    fn discovers_a_running_responder_scoped_to_the_same_restaurant() {
        let (port, stop_flag, handle) = spawn_responder("restaurant-a");

        let found = discover_hubs("restaurant-a", port, Duration::from_millis(500)).unwrap();

        stop_flag.store(true, Ordering::SeqCst);
        handle.join().unwrap();

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].device_id, "device-1");
        assert_eq!(found[0].branch_id, "branch-1");
        assert_eq!(found[0].http_port, 4000);
        assert_eq!(found[0].ws_port, 4001);
    }

    #[test]
    fn a_responder_never_replies_to_a_different_restaurants_request() {
        let (port, stop_flag, handle) = spawn_responder("restaurant-a");

        let found = discover_hubs("restaurant-b", port, Duration::from_millis(500)).unwrap();

        stop_flag.store(true, Ordering::SeqCst);
        handle.join().unwrap();

        assert_eq!(found.len(), 0);
    }

    #[test]
    fn finding_nothing_on_an_empty_network_returns_an_empty_list_not_an_error() {
        // No responder bound to this port at all. Port 0 isn't valid here —
        // unlike bind(), UDP sendto() rejects a literal destination port 0
        // with EINVAL on Linux (this only went unnoticed on Windows, which
        // tolerates it) — so this uses a real, almost-certainly-unused port.
        let found = discover_hubs("restaurant-a", 1, Duration::from_millis(200)).unwrap();
        assert_eq!(found, vec![]);
    }
}
