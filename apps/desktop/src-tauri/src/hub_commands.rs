//! P2-36/P2-37/P2-38: the frontend's entry points for hub mode — start/
//! stop the local servers, check status, refresh the cached device roster
//! they authenticate against, find a hub on the local network (or verify a
//! manually-entered one), and publish this terminal's own local changes
//! into the shared-state relay when it's acting as the hub. No frontend
//! screen calls these yet (same "backend/transport layer first, wiring
//! follows" scoping as every other primitive this phase) — there's still
//! no real order/table-status feature on the frontend to drive
//! `publish_hub_update` from.
use crate::db::{self, DbState};
use crate::hub_auth::RosterEntry;
use crate::hub_discovery::{self, DiscoveredHub, HubIdentityInput};
use crate::hub_roster;
use crate::hub_server::{self, HubServerHandle};
use crate::hub_state::{self, StateEntry};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

const MANUAL_CHECK_TIMEOUT: Duration = Duration::from_secs(5);

/// `None` means hub mode is off. Holding the same `roster` Arc the running
/// server was started with (not just the handle) is what lets
/// `refresh_hub_roster` update a *running* hub's live roster in place —
/// without this, a refresh while the hub is already running would only
/// ever affect the next restart, not the connections it's gating right
/// now.
pub struct HubState(pub Mutex<Option<(HubServerHandle, Arc<Mutex<Vec<RosterEntry>>>)>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubStatus {
    pub running: bool,
    pub http_port: Option<u16>,
    pub ws_port: Option<u16>,
    pub discovery_port: Option<u16>,
}

/// `device_id`/`restaurant_id`/`branch_id` are this terminal's own — the
/// frontend already has them from its own paired-device lookup (`GET
/// /devices/me`) — and become the identity P2-37's discovery responder
/// broadcasts. The discovery responder always binds the real, well-known
/// `hub_discovery::DISCOVERY_PORT`; only `http_port`/`ws_port` are
/// caller-chosen.
#[tauri::command]
pub fn start_hub(
    app_handle: AppHandle,
    db_state: State<DbState>,
    hub_state: State<HubState>,
    device_id: String,
    restaurant_id: String,
    branch_id: String,
    http_port: u16,
    ws_port: u16,
) -> Result<HubStatus, String> {
    let mut hub_guard = hub_state.0.lock().map_err(|e| e.to_string())?;
    if hub_guard.is_some() {
        return Err("hub is already running".to_string());
    }

    let (roster_entries, initial_state) = {
        let db_guard = db_state.0.lock().map_err(|e| e.to_string())?;
        let conn = db_guard.as_ref().ok_or_else(|| "local database unavailable".to_string())?;
        let roster_entries = hub_roster::load_roster(conn).map_err(|e| e.to_string())?;
        // P2-38: resumes the relay from whatever was already shared before
        // this hub last stopped (a crash, a restart) — same "don't lose
        // what's already there" reasoning as the roster cache itself.
        let initial_state = hub_state::load_all(conn).map_err(|e| e.to_string())?;
        (roster_entries, initial_state)
    };
    let roster: Arc<Mutex<Vec<RosterEntry>>> = Arc::new(Mutex::new(roster_entries));

    // A second, independent connection to the same encrypted database
    // (rule: WAL mode supports this) so the relay's background threads can
    // persist shared-state updates on their own, without contending with
    // DbState's connection, which every ordinary Tauri command locks for
    // the length of its own call.
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let hub_db = db::open_secondary(&app_data_dir).map_err(|e| e.to_string())?;

    let identity = HubIdentityInput { device_id, restaurant_id, branch_id };
    let handle = hub_server::start(roster.clone(), http_port, ws_port, identity, hub_discovery::DISCOVERY_PORT, initial_state, hub_db).map_err(|e| e.to_string())?;
    let status = HubStatus { running: true, http_port: Some(handle.http_port), ws_port: Some(handle.ws_port), discovery_port: Some(handle.discovery_port) };
    *hub_guard = Some((handle, roster));
    Ok(status)
}

#[tauri::command]
pub fn stop_hub(hub_state: State<HubState>) -> Result<(), String> {
    let mut guard = hub_state.0.lock().map_err(|e| e.to_string())?;
    if let Some((handle, _roster)) = guard.take() {
        handle.stop();
    }
    Ok(())
}

#[tauri::command]
pub fn get_hub_status(hub_state: State<HubState>) -> Result<HubStatus, String> {
    let guard = hub_state.0.lock().map_err(|e| e.to_string())?;
    Ok(match guard.as_ref() {
        Some((handle, _roster)) => HubStatus { running: true, http_port: Some(handle.http_port), ws_port: Some(handle.ws_port), discovery_port: Some(handle.discovery_port) },
        None => HubStatus { running: false, http_port: None, ws_port: None, discovery_port: None },
    })
}

/// P2-37: broadcasts a discovery request scoped to `restaurant_id` and
/// collects whatever hubs reply within `timeout_ms` — the "automatic"
/// half. An empty result is routine (no hub running, or a network that
/// blocks broadcast traffic), never an error; the manual-IP fallback
/// (`check_hub_reachable`) is what a setup screen would offer next.
#[tauri::command]
pub fn discover_hubs(restaurant_id: String, timeout_ms: u64) -> Result<Vec<DiscoveredHub>, String> {
    hub_discovery::discover_hubs(&restaurant_id, hub_discovery::DISCOVERY_PORT, Duration::from_millis(timeout_ms)).map_err(|e| e.to_string())
}

/// P2-37's manual-IP fallback: just confirms *something* answers
/// `GET /health` at the given address — same trust model as typing a
/// printer's IP in P2-35's setup screen (the user already knows this is
/// the right machine; this only proves it's reachable), not an identity
/// check the way broadcast discovery's restaurant-scoping is.
#[tauri::command]
pub fn check_hub_reachable(ip: String, http_port: u16) -> Result<bool, String> {
    let url = format!("http://{ip}:{http_port}/health");
    let client = reqwest::blocking::Client::builder().timeout(MANUAL_CHECK_TIMEOUT).build().map_err(|e| e.to_string())?;
    Ok(client.get(url).send().map(|response| response.status().is_success()).unwrap_or(false))
}

/// Fetches this branch's current roster from the server, persists it (so
/// it survives a restart), and — if the hub is currently running — also
/// swaps it into the live `Arc` the server is already checking connections
/// against, so the refresh takes effect immediately, not just on the next
/// start. Needs this terminal's own device token (same convention as
/// `menu_commands.rs`'s `sync_menu`), so the fetch itself only works while
/// online; `hub_auth.rs` then verifies peers against whatever was last
/// cached here entirely offline afterward.
#[tauri::command]
pub fn refresh_hub_roster(db_state: State<DbState>, hub_state: State<HubState>, api_base_url: String, device_token: String) -> Result<usize, String> {
    let entries = hub_roster::fetch_roster_from_server(&api_base_url, &device_token).map_err(|e| e.to_string())?;

    {
        let guard = db_state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or_else(|| "local database unavailable".to_string())?;
        hub_roster::replace_roster(conn, &entries).map_err(|e| e.to_string())?;
    }

    let hub_guard = hub_state.0.lock().map_err(|e| e.to_string())?;
    if let Some((_handle, roster)) = hub_guard.as_ref() {
        *roster.lock().map_err(|e| e.to_string())? = entries.clone();
    }

    Ok(entries.len())
}

/// P2-38: this terminal's own local change, published into the shared
/// relay — only meaningful while THIS terminal is running as the hub
/// (there's nothing to publish into if it isn't; a non-hub device
/// publishes instead by sending a `state_update` over its own outgoing
/// WebSocket connection to whichever device IS the hub, which needs no
/// Rust involvement at all — the browser's native WebSocket API is enough
/// for that side, same reasoning printer discovery's client already
/// didn't need one). `entity_kind` is free-form (the three this task
/// names are `order`/`table_status`/`kitchen_ticket`, but this transport
/// layer never validates which); `version` should be a monotonically
/// increasing number per entity (a millisecond timestamp works) — an
/// older or equal version is silently dropped, never an error, same as a
/// remote device's stale update.
#[tauri::command]
pub fn publish_hub_update(hub_state: State<HubState>, entity_kind: String, entity_id: String, version: u64, payload: serde_json::Value, origin_device_id: String) -> Result<bool, String> {
    let guard = hub_state.0.lock().map_err(|e| e.to_string())?;
    let (handle, _roster) = guard.as_ref().ok_or_else(|| "hub is not running".to_string())?;
    Ok(handle.publish(StateEntry { entity_kind, entity_id, version, origin_device_id, payload }))
}
