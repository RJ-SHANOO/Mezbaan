//! P2-38: the hub's shared-state store — one entry per `(entityKind,
//! entityId)`, used to relay orders/table status/kitchen tickets between
//! devices connected to the same branch hub. This is a LAN convenience
//! cache for devices to stay in sync with each other *right now*, not a
//! financial record — the real sale is still recorded through the real
//! server once connectivity returns (rule 3/4 don't apply to this table).
//!
//! Conflict resolution is deliberately simple: `version` is a monotonic
//! number the *caller* supplies (in practice, a timestamp in
//! milliseconds) — `apply_if_newer` only ever accepts a version strictly
//! greater than whatever's already stored for that entity, silently
//! dropping anything older or equal (a duplicate relay, two devices
//! racing on the same table). This is last-write-wins by caller-supplied
//! version, not a CRDT or true conflict merge — adequate for a transport
//! layer whose whole job is "don't let a stale update clobber a newer
//! one," not for resolving two genuinely concurrent edits to the same
//! financial record (that's what rule 3's server-side recalculation on
//! sync is for).
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;

pub type StateKey = (String, String);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateEntry {
    pub entity_kind: String,
    pub entity_id: String,
    pub version: u64,
    pub origin_device_id: String,
    /// Opaque to this module — whatever shape the real order/table-status/
    /// kitchen-ticket feature wants it to be; this transport layer never
    /// inspects it.
    pub payload: serde_json::Value,
}

impl StateEntry {
    pub fn key(&self) -> StateKey {
        (self.entity_kind.clone(), self.entity_id.clone())
    }
}

#[derive(Debug)]
pub struct HubStateError(String);

impl fmt::Display for HubStateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "hub shared-state error: {}", self.0)
    }
}

impl std::error::Error for HubStateError {}

impl From<rusqlite::Error> for HubStateError {
    fn from(e: rusqlite::Error) -> Self {
        HubStateError(e.to_string())
    }
}

impl From<serde_json::Error> for HubStateError {
    fn from(e: serde_json::Error) -> Self {
        HubStateError(e.to_string())
    }
}

/// Applies `entry` to the in-memory `store` only if it's strictly newer
/// than whatever's already there for the same entity — the one rule this
/// whole relay exists to enforce. Returns whether it was actually applied;
/// the caller only persists/broadcasts when this is `true`.
pub fn apply_if_newer(store: &mut HashMap<StateKey, StateEntry>, entry: StateEntry) -> bool {
    let key = entry.key();
    let should_apply = match store.get(&key) {
        Some(existing) => entry.version > existing.version,
        None => true,
    };
    if should_apply {
        store.insert(key, entry);
    }
    should_apply
}

pub fn persist(conn: &Connection, entry: &StateEntry) -> Result<(), HubStateError> {
    conn.execute(
        "INSERT INTO hub_shared_state (entity_kind, entity_id, version, origin_device_id, payload, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
           version = excluded.version,
           origin_device_id = excluded.origin_device_id,
           payload = excluded.payload,
           updated_at = excluded.updated_at",
        params![entry.entity_kind, entry.entity_id, entry.version as i64, entry.origin_device_id, serde_json::to_string(&entry.payload)?],
    )?;
    Ok(())
}

pub fn load_all(conn: &Connection) -> Result<HashMap<StateKey, StateEntry>, HubStateError> {
    let mut stmt = conn.prepare("SELECT entity_kind, entity_id, version, origin_device_id, payload FROM hub_shared_state")?;
    let rows = stmt.query_map([], |row| {
        let version: i64 = row.get(2)?;
        let payload_json: String = row.get(4)?;
        Ok((version, payload_json, row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(3)?))
    })?;

    let mut store = HashMap::new();
    for row in rows {
        let (version, payload_json, entity_kind, entity_id, origin_device_id) = row?;
        let payload: serde_json::Value = serde_json::from_str(&payload_json)?;
        let entry = StateEntry { entity_kind, entity_id, version: version as u64, origin_device_id, payload };
        store.insert(entry.key(), entry);
    }
    Ok(store)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(kind: &str, id: &str, version: u64) -> StateEntry {
        StateEntry { entity_kind: kind.to_string(), entity_id: id.to_string(), version, origin_device_id: "device-1".to_string(), payload: json!({"status": "occupied"}) }
    }

    #[test]
    fn apply_if_newer_accepts_the_first_entry_for_a_key() {
        let mut store = HashMap::new();
        assert!(apply_if_newer(&mut store, entry("table_status", "t1", 1)));
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn apply_if_newer_rejects_an_older_or_equal_version() {
        let mut store = HashMap::new();
        apply_if_newer(&mut store, entry("table_status", "t1", 5));

        assert!(!apply_if_newer(&mut store, entry("table_status", "t1", 3)));
        assert!(!apply_if_newer(&mut store, entry("table_status", "t1", 5)));
        assert_eq!(store.get(&("table_status".to_string(), "t1".to_string())).unwrap().version, 5);
    }

    #[test]
    fn apply_if_newer_accepts_a_strictly_newer_version_and_replaces_the_entry() {
        let mut store = HashMap::new();
        apply_if_newer(&mut store, entry("table_status", "t1", 5));
        assert!(apply_if_newer(&mut store, entry("table_status", "t1", 6)));
        assert_eq!(store.get(&("table_status".to_string(), "t1".to_string())).unwrap().version, 6);
    }

    #[test]
    fn different_entity_kinds_with_the_same_id_are_tracked_independently() {
        let mut store = HashMap::new();
        apply_if_newer(&mut store, entry("order", "x1", 1));
        apply_if_newer(&mut store, entry("kitchen_ticket", "x1", 1));
        assert_eq!(store.len(), 2);
    }

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../migrations/0009_hub_shared_state.sql")).unwrap();
        conn
    }

    #[test]
    fn persist_then_load_all_round_trips() {
        let conn = test_conn();
        persist(&conn, &entry("table_status", "t1", 3)).unwrap();
        persist(&conn, &entry("order", "o1", 7)).unwrap();

        let loaded = load_all(&conn).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded.get(&("table_status".to_string(), "t1".to_string())).unwrap().version, 3);
        assert_eq!(loaded.get(&("order".to_string(), "o1".to_string())).unwrap().version, 7);
    }

    #[test]
    fn persisting_the_same_key_again_upserts_rather_than_duplicating() {
        let conn = test_conn();
        persist(&conn, &entry("table_status", "t1", 1)).unwrap();
        persist(&conn, &entry("table_status", "t1", 2)).unwrap();

        let loaded = load_all(&conn).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded.get(&("table_status".to_string(), "t1".to_string())).unwrap().version, 2);
    }
}
