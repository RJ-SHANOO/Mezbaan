//! The data behind P1-29's sync status indicator: pending count (operation_log),
//! last successful sync, and whether the most recent sync attempt actually reached
//! the server. Persisted in app_metadata (P1-19) — same key-value store
//! pending_work.rs already uses — rather than a dedicated table, since this is just
//! two scalar values, not a growing log of its own.
use crate::operation_log;
use rusqlite::{Connection, OptionalExtension};
use std::fmt;

const LAST_SUCCESSFUL_SYNC_AT_KEY: &str = "sync_last_successful_at";
const LAST_ATTEMPT_ONLINE_KEY: &str = "sync_last_attempt_online";

#[derive(Debug)]
pub enum SyncStatusError {
    Db(rusqlite::Error),
    OperationLog(operation_log::OperationLogError),
}

impl fmt::Display for SyncStatusError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SyncStatusError::Db(e) => write!(f, "sync status storage error: {e}"),
            SyncStatusError::OperationLog(e) => write!(f, "sync status: {e}"),
        }
    }
}

impl std::error::Error for SyncStatusError {}

impl From<rusqlite::Error> for SyncStatusError {
    fn from(e: rusqlite::Error) -> Self {
        SyncStatusError::Db(e)
    }
}

impl From<operation_log::OperationLogError> for SyncStatusError {
    fn from(e: operation_log::OperationLogError) -> Self {
        SyncStatusError::OperationLog(e)
    }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub pending_count: i64,
    /// None until the very first sync attempt this install has ever made.
    pub last_successful_sync_at: Option<String>,
    /// None before the first attempt; after that, whether the *most recent*
    /// attempt reached the server at all — independent of whether it actually had
    /// anything to send (an empty successful cycle still proves connectivity).
    pub online: Option<bool>,
}

/// Called by the sync client after every cycle — `succeeded` means the transport
/// itself worked (even a 0-operation cycle counts), not that every operation in it
/// was accepted; a rejected operation is still a successful, online cycle.
pub fn record_sync_attempt(conn: &Connection, succeeded: bool) -> Result<(), SyncStatusError> {
    set_metadata(conn, LAST_ATTEMPT_ONLINE_KEY, if succeeded { "true" } else { "false" })?;
    if succeeded {
        conn.execute(
            "INSERT INTO app_metadata (key, value) VALUES (?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [LAST_SUCCESSFUL_SYNC_AT_KEY],
        )?;
    }
    Ok(())
}

fn set_metadata(conn: &Connection, key: &str, value: &str) -> Result<(), SyncStatusError> {
    conn.execute(
        "INSERT INTO app_metadata (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )?;
    Ok(())
}

pub fn get_status(conn: &Connection) -> Result<SyncStatus, SyncStatusError> {
    let pending_count = operation_log::count_unsynced(conn)?;
    let last_successful_sync_at: Option<String> = conn
        .query_row("SELECT value FROM app_metadata WHERE key = ?1", [LAST_SUCCESSFUL_SYNC_AT_KEY], |row| row.get(0))
        .optional()?;
    let online_raw: Option<String> = conn
        .query_row("SELECT value FROM app_metadata WHERE key = ?1", [LAST_ATTEMPT_ONLINE_KEY], |row| row.get(0))
        .optional()?;
    let online = online_raw.map(|v| v == "true");
    Ok(SyncStatus { pending_count, last_successful_sync_at, online })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);").unwrap();
        conn.execute_batch(include_str!("../migrations/0002_operation_log.sql")).unwrap();
        conn
    }

    #[test]
    fn before_any_sync_attempt_everything_is_unknown_and_pending_is_zero() {
        let conn = test_conn();
        let status = get_status(&conn).unwrap();
        assert_eq!(status, SyncStatus { pending_count: 0, last_successful_sync_at: None, online: None });
    }

    #[test]
    fn a_successful_attempt_sets_online_true_and_records_the_timestamp() {
        let conn = test_conn();
        record_sync_attempt(&conn, true).unwrap();

        let status = get_status(&conn).unwrap();
        assert_eq!(status.online, Some(true));
        assert!(status.last_successful_sync_at.is_some());
    }

    #[test]
    fn a_failed_attempt_sets_online_false_but_leaves_last_successful_sync_untouched() {
        let conn = test_conn();
        record_sync_attempt(&conn, true).unwrap();
        let first_success_at = get_status(&conn).unwrap().last_successful_sync_at;

        record_sync_attempt(&conn, false).unwrap();

        let status = get_status(&conn).unwrap();
        assert_eq!(status.online, Some(false));
        assert_eq!(status.last_successful_sync_at, first_success_at);
    }

    #[test]
    fn pending_count_reflects_operation_log() {
        let conn = test_conn();
        conn.execute(
            "INSERT INTO operation_log (id, idempotency_key, operation_type, payload) VALUES ('id-1', 'key-1', 'widget.created', '{}')",
            [],
        )
        .unwrap();

        assert_eq!(get_status(&conn).unwrap().pending_count, 1);
    }
}
