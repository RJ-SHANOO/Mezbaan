//! P2-45: persists this terminal's own branch_number/terminal_number — the
//! server-assigned, UNIQUE-per-device pair P1-20's pairing response already
//! returns (packages/contracts' DeviceSchema) but that nothing previously
//! kept around locally. document_number.rs's own docs call this out as the
//! caller's responsibility to source "from wherever this terminal's own
//! paired device record is kept" — this module is that place, so an offline
//! sale can mint a P1-28 document number with no network call.
//!
//! Same single-JSON-blob-in-app_metadata shape as printer_settings.rs —
//! one small setting, no need for a dedicated table.
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fmt;

const DEVICE_IDENTITY_KEY: &str = "device_identity";

#[derive(Debug)]
pub struct DeviceIdentityError(rusqlite::Error);

impl fmt::Display for DeviceIdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "device identity storage error: {}", self.0)
    }
}

impl std::error::Error for DeviceIdentityError {}

impl From<rusqlite::Error> for DeviceIdentityError {
    fn from(e: rusqlite::Error) -> Self {
        DeviceIdentityError(e)
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
pub struct DeviceIdentity {
    pub branch_number: i64,
    pub terminal_number: i64,
}

/// Overwrites any previously stored identity — correct for this terminal
/// being unpaired and re-paired (possibly to a different branch), since
/// there's only ever one live identity for a single terminal's own database.
pub fn save(conn: &Connection, identity: DeviceIdentity) -> Result<(), DeviceIdentityError> {
    let json = serde_json::to_string(&identity).expect("DeviceIdentity always serializes");
    conn.execute(
        "INSERT INTO app_metadata (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (DEVICE_IDENTITY_KEY, json),
    )?;
    Ok(())
}

/// `None` means this terminal has never completed pairing (or its stored
/// identity was cleared) — callers that need it to mint a document number
/// should treat that as "not paired yet", not as an error to swallow.
pub fn load(conn: &Connection) -> Result<Option<DeviceIdentity>, DeviceIdentityError> {
    let raw: Option<String> = conn.query_row("SELECT value FROM app_metadata WHERE key = ?1", [DEVICE_IDENTITY_KEY], |row| row.get(0)).optional()?;
    Ok(raw.map(|json| serde_json::from_str(&json).expect("a previously saved DeviceIdentity always deserializes")))
}

pub fn clear(conn: &Connection) -> Result<(), DeviceIdentityError> {
    conn.execute("DELETE FROM app_metadata WHERE key = ?1", [DEVICE_IDENTITY_KEY])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);").unwrap();
        conn
    }

    #[test]
    fn load_on_an_empty_store_is_none() {
        let conn = test_conn();
        assert_eq!(load(&conn).unwrap(), None);
    }

    #[test]
    fn saves_and_loads_the_identity_back_verbatim() {
        let conn = test_conn();
        let identity = DeviceIdentity { branch_number: 1, terminal_number: 2 };
        save(&conn, identity).unwrap();
        assert_eq!(load(&conn).unwrap(), Some(identity));
    }

    #[test]
    fn saving_again_overwrites_rather_than_accumulates() {
        let conn = test_conn();
        save(&conn, DeviceIdentity { branch_number: 1, terminal_number: 2 }).unwrap();
        save(&conn, DeviceIdentity { branch_number: 3, terminal_number: 4 }).unwrap();
        assert_eq!(load(&conn).unwrap(), Some(DeviceIdentity { branch_number: 3, terminal_number: 4 }));
    }

    #[test]
    fn clear_removes_it() {
        let conn = test_conn();
        save(&conn, DeviceIdentity { branch_number: 1, terminal_number: 2 }).unwrap();
        clear(&conn).unwrap();
        assert_eq!(load(&conn).unwrap(), None);
    }
}
