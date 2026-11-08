//! Per-terminal document number series (P1-28, rule 10): "B1-T2-000123" — the branch
//! and terminal numbers come from the server (assigned once, server-side, at branch
//! creation and device pairing — see packages/db/src/schema/branches.ts's
//! branch_number and devices.ts's terminal_number, each backed by a UNIQUE index so
//! two terminals can never legitimately share one), and the trailing sequence is a
//! purely local counter that needs no server round-trip to advance. Combining a
//! server-guaranteed-unique prefix with a local counter is what makes two different
//! terminals' numbers unable to collide even while both are offline — neither one
//! needs to know what the other is doing.
use rusqlite::Connection;
use std::fmt;

#[derive(Debug)]
pub struct DocumentNumberError(rusqlite::Error);

impl fmt::Display for DocumentNumberError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "document number sequence error: {}", self.0)
    }
}

impl std::error::Error for DocumentNumberError {}

impl From<rusqlite::Error> for DocumentNumberError {
    fn from(e: rusqlite::Error) -> Self {
        DocumentNumberError(e)
    }
}

/// Consumes and returns the next sequence number — never reused, never reset, even
/// across restarts (that's the whole point of persisting it in SQLite rather than
/// keeping it in memory).
fn next_sequence_number(conn: &mut Connection) -> Result<i64, DocumentNumberError> {
    let tx = conn.transaction()?;
    let current: i64 = tx.query_row("SELECT next_number FROM document_number_sequence WHERE id = 1", [], |row| row.get(0))?;
    tx.execute("UPDATE document_number_sequence SET next_number = next_number + 1 WHERE id = 1", [])?;
    tx.commit()?;
    Ok(current)
}

/// Formats as "B{branch_number}-T{terminal_number}-{sequence:06}" — branch_number
/// and terminal_number are the caller's responsibility to supply, sourced from
/// wherever this terminal's own paired device record is kept (P1-20's pairing
/// response already returns them; persisting that locally for a caller to read back
/// is outside this module's job).
pub fn next_document_number(conn: &mut Connection, branch_number: i64, terminal_number: i64) -> Result<String, DocumentNumberError> {
    let sequence = next_sequence_number(conn)?;
    Ok(format!("B{branch_number}-T{terminal_number}-{sequence:06}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../migrations/0004_document_number_sequence.sql")).unwrap();
        conn
    }

    #[test]
    fn formats_as_branch_terminal_zero_padded_sequence() {
        let mut conn = test_conn();
        assert_eq!(next_document_number(&mut conn, 1, 2).unwrap(), "B1-T2-000001");
    }

    #[test]
    fn increments_on_every_call_and_never_repeats() {
        let mut conn = test_conn();
        let first = next_document_number(&mut conn, 1, 2).unwrap();
        let second = next_document_number(&mut conn, 1, 2).unwrap();
        let third = next_document_number(&mut conn, 1, 2).unwrap();

        assert_eq!(first, "B1-T2-000001");
        assert_eq!(second, "B1-T2-000002");
        assert_eq!(third, "B1-T2-000003");
    }

    #[test]
    fn the_sequence_is_shared_across_calls_regardless_of_branch_terminal_arguments() {
        // branch_number/terminal_number only affect formatting — there's exactly one
        // sequence per terminal (this database), since a single terminal only ever
        // has one branch/terminal number of its own. Passing different numbers here
        // just proves the counter itself isn't keyed by them.
        let mut conn = test_conn();
        let first = next_document_number(&mut conn, 1, 2).unwrap();
        let second = next_document_number(&mut conn, 3, 4).unwrap();

        assert_eq!(first, "B1-T2-000001");
        assert_eq!(second, "B3-T4-000002");
    }

    #[test]
    fn survives_a_fresh_connection_to_the_same_database_without_resetting() {
        let dir = std::env::temp_dir().join(format!(
            "mezbaan-docnum-test-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("test.db");

        {
            let mut conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(include_str!("../migrations/0004_document_number_sequence.sql")).unwrap();
            assert_eq!(next_document_number(&mut conn, 1, 1).unwrap(), "B1-T1-000001");
        }
        {
            let mut conn = Connection::open(&db_path).unwrap();
            assert_eq!(next_document_number(&mut conn, 1, 1).unwrap(), "B1-T1-000002");
        }
    }
}
