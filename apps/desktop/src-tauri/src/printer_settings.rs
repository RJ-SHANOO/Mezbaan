//! P2-35: persists the one printer connection branch staff configured on
//! this terminal — a JSON-encoded PrinterConnectionConfig in the same
//! app_metadata key-value table pending_work.rs already uses for its own
//! single blob, same reasoning: one setting, no need for a dedicated table.
use rusqlite::{Connection, OptionalExtension};
use std::fmt;

const PRINTER_CONFIG_KEY: &str = "printer_config";

#[derive(Debug)]
pub struct PrinterSettingsError(rusqlite::Error);

impl fmt::Display for PrinterSettingsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "printer settings storage error: {}", self.0)
    }
}

impl std::error::Error for PrinterSettingsError {}

impl From<rusqlite::Error> for PrinterSettingsError {
    fn from(e: rusqlite::Error) -> Self {
        PrinterSettingsError(e)
    }
}

/// `json` is already a serialized PrinterConnectionConfig — this module
/// doesn't parse it, same "frontend/caller owns the shape" reasoning as
/// pending_work.rs.
pub fn save(conn: &Connection, json: &str) -> Result<(), PrinterSettingsError> {
    conn.execute(
        "INSERT INTO app_metadata (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (PRINTER_CONFIG_KEY, json),
    )?;
    Ok(())
}

pub fn load(conn: &Connection) -> Result<Option<String>, PrinterSettingsError> {
    Ok(conn
        .query_row("SELECT value FROM app_metadata WHERE key = ?1", [PRINTER_CONFIG_KEY], |row| row.get(0))
        .optional()?)
}

pub fn clear(conn: &Connection) -> Result<(), PrinterSettingsError> {
    conn.execute("DELETE FROM app_metadata WHERE key = ?1", [PRINTER_CONFIG_KEY])?;
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
    fn saves_and_loads_the_config_back_verbatim() {
        let conn = test_conn();
        let json = r#"{"kind":"network","host":"192.168.1.50","port":9100,"timeout_ms":5000}"#;
        save(&conn, json).unwrap();
        assert_eq!(load(&conn).unwrap(), Some(json.to_string()));
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
}
