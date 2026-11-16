//! P2-36: caching the branch's paired-device roster locally, and the one
//! call that actually goes over the network to refresh it.
use crate::hub_auth::RosterEntry;
use rusqlite::{params, Connection};
use serde::Deserialize;
use std::fmt;
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub enum HubRosterError {
    Storage(String),
    Transport(String),
}

impl fmt::Display for HubRosterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HubRosterError::Storage(detail) => write!(f, "hub roster storage error: {detail}"),
            HubRosterError::Transport(detail) => write!(f, "hub roster fetch failed: {detail}"),
        }
    }
}

impl std::error::Error for HubRosterError {}

impl From<rusqlite::Error> for HubRosterError {
    fn from(e: rusqlite::Error) -> Self {
        HubRosterError::Storage(e.to_string())
    }
}

/// Wholesale replace, same "server's version wins" convention as
/// menu_cache.rs — a device revoked server-side simply isn't in the next
/// refresh, rather than this module having to reconcile an incremental diff.
pub fn replace_roster(conn: &Connection, entries: &[RosterEntry]) -> Result<(), HubRosterError> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM hub_device_roster", [])?;
    for entry in entries {
        tx.execute("INSERT INTO hub_device_roster (device_id, token_hash) VALUES (?1, ?2)", params![entry.device_id, entry.token_hash])?;
    }
    tx.commit()?;
    Ok(())
}

pub fn load_roster(conn: &Connection) -> Result<Vec<RosterEntry>, HubRosterError> {
    let mut stmt = conn.prepare("SELECT device_id, token_hash FROM hub_device_roster")?;
    let rows = stmt.query_map([], |row| Ok(RosterEntry { device_id: row.get(0)?, token_hash: row.get(1)? }))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[derive(Debug, Deserialize)]
struct RosterEntryResponse {
    #[serde(rename = "deviceId")]
    device_id: String,
    #[serde(rename = "tokenHash")]
    token_hash: String,
}

/// `api_base_url`/`device_token` are this terminal's own — same convention
/// as menu_commands.rs's sync_menu — fetching `GET /devices/roster`
/// (devices-terminal.controller.ts), itself gated by DeviceAuthGuard, so
/// only an already-paired device can ever pull the roster in the first
/// place.
pub fn fetch_roster_from_server(api_base_url: &str, device_token: &str) -> Result<Vec<RosterEntry>, HubRosterError> {
    let url = format!("{}/devices/roster", api_base_url.trim_end_matches('/'));
    let client = reqwest::blocking::Client::builder().timeout(REQUEST_TIMEOUT).build().map_err(|e| HubRosterError::Transport(e.to_string()))?;
    let response = client.get(url).header("x-device-token", device_token).send().map_err(|e| HubRosterError::Transport(e.to_string()))?;
    if !response.status().is_success() {
        return Err(HubRosterError::Transport(format!("roster endpoint returned {}", response.status())));
    }
    let body: Vec<RosterEntryResponse> = response.json().map_err(|e| HubRosterError::Transport(e.to_string()))?;
    Ok(body.into_iter().map(|entry| RosterEntry { device_id: entry.device_id, token_hash: entry.token_hash }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../migrations/0008_hub_device_roster.sql")).unwrap();
        conn
    }

    #[test]
    fn load_on_an_empty_store_is_empty() {
        let conn = test_conn();
        assert_eq!(load_roster(&conn).unwrap(), vec![]);
    }

    #[test]
    fn replace_then_load_round_trips() {
        let conn = test_conn();
        let entries = vec![
            RosterEntry { device_id: "d1".to_string(), token_hash: "hash1".to_string() },
            RosterEntry { device_id: "d2".to_string(), token_hash: "hash2".to_string() },
        ];
        replace_roster(&conn, &entries).unwrap();

        let mut loaded = load_roster(&conn).unwrap();
        loaded.sort_by(|a, b| a.device_id.cmp(&b.device_id));
        assert_eq!(loaded, entries);
    }

    #[test]
    fn replacing_again_wholesale_replaces_rather_than_accumulating() {
        let conn = test_conn();
        replace_roster(&conn, &[RosterEntry { device_id: "d1".to_string(), token_hash: "hash1".to_string() }]).unwrap();
        replace_roster(&conn, &[RosterEntry { device_id: "d2".to_string(), token_hash: "hash2".to_string() }]).unwrap();

        let loaded = load_roster(&conn).unwrap();
        assert_eq!(loaded, vec![RosterEntry { device_id: "d2".to_string(), token_hash: "hash2".to_string() }]);
    }

    #[test]
    fn replacing_with_an_empty_list_clears_the_roster() {
        let conn = test_conn();
        replace_roster(&conn, &[RosterEntry { device_id: "d1".to_string(), token_hash: "hash1".to_string() }]).unwrap();
        replace_roster(&conn, &[]).unwrap();
        assert_eq!(load_roster(&conn).unwrap(), vec![]);
    }
}
