use rusqlite::{Connection, OptionalExtension};
use std::fmt;

const PENDING_WORK_KEY: &str = "pending_work";

#[derive(Debug)]
pub struct PendingWorkError(rusqlite::Error);

impl fmt::Display for PendingWorkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "pending work storage error: {}", self.0)
    }
}

impl std::error::Error for PendingWorkError {}

impl From<rusqlite::Error> for PendingWorkError {
    fn from(e: rusqlite::Error) -> Self {
        PendingWorkError(e)
    }
}

/// A generic "whatever the frontend considers in-progress" slot (P1-22) — a single
/// opaque JSON blob in the local database (app_metadata, from P1-19), not tied to a
/// real schema since there's no order/cart yet (that's Phase 2). The frontend owns
/// the shape; this just persists and returns it verbatim, so a crash-and-restart
/// (via the watchdog) doesn't lose whatever was on screen.
pub fn save(conn: &Connection, json: &str) -> Result<(), PendingWorkError> {
    conn.execute(
        "INSERT INTO app_metadata (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (PENDING_WORK_KEY, json),
    )?;
    Ok(())
}

pub fn load(conn: &Connection) -> Result<Option<String>, PendingWorkError> {
    Ok(conn
        .query_row("SELECT value FROM app_metadata WHERE key = ?1", [PENDING_WORK_KEY], |row| row.get(0))
        .optional()?)
}

pub fn clear(conn: &Connection) -> Result<(), PendingWorkError> {
    conn.execute("DELETE FROM app_metadata WHERE key = ?1", [PENDING_WORK_KEY])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();
        conn
    }

    #[test]
    fn load_on_an_empty_store_is_none() {
        let conn = test_conn();
        assert_eq!(load(&conn).unwrap(), None);
    }

    #[test]
    fn saves_and_loads_the_blob_back_verbatim() {
        let conn = test_conn();
        save(&conn, r#"{"cart":["burger","fries"]}"#).unwrap();
        assert_eq!(load(&conn).unwrap(), Some(r#"{"cart":["burger","fries"]}"#.to_string()));
    }

    #[test]
    fn saving_again_overwrites_rather_than_accumulates() {
        let conn = test_conn();
        save(&conn, "first").unwrap();
        save(&conn, "second").unwrap();
        assert_eq!(load(&conn).unwrap(), Some("second".to_string()));
    }

    #[test]
    fn clear_removes_it() {
        let conn = test_conn();
        save(&conn, "something").unwrap();
        clear(&conn).unwrap();
        assert_eq!(load(&conn).unwrap(), None);
    }

    #[test]
    fn clearing_an_already_empty_store_is_a_no_op() {
        let conn = test_conn();
        clear(&conn).unwrap();
        assert_eq!(load(&conn).unwrap(), None);
    }
}
