//! The local operation log (P1-24): rule 8 requires every terminal write to land in
//! SQLite and here in the *same* local transaction, and rule 9 requires a
//! client-generated UUIDv7 id plus an idempotency key so a retried operation (a
//! crash mid-write, a network hiccup that makes the UI resubmit) can never create a
//! duplicate. `record_once` is the single place that invariant is enforced: it opens
//! one transaction, checks the idempotency key, runs the caller's actual business
//! write inside that same transaction, and only then appends the log row — so the
//! business write and its log entry always commit (or roll back) together.
//!
//! There's no real business write to call this from yet — orders/cart are Phase 2 —
//! so this is the generic primitive only, exercised here with synthetic writes
//! against a throwaway table; a real caller composes its own write closure with its
//! own error type (it only needs `From<rusqlite::Error>`, the same requirement every
//! other error type in this crate already satisfies).
use rusqlite::{Connection, Transaction};
use std::fmt;

#[derive(Debug)]
pub struct OperationLogError(rusqlite::Error);

impl fmt::Display for OperationLogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "operation log error: {}", self.0)
    }
}

impl std::error::Error for OperationLogError {}

impl From<rusqlite::Error> for OperationLogError {
    fn from(e: rusqlite::Error) -> Self {
        OperationLogError(e)
    }
}

/// A client-generated, time-ordered operation id (rule 9). Distinct from an
/// idempotency key in the schema (see migrations/0002_operation_log.sql) even though
/// callers will typically pass the same value for both.
pub fn new_operation_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

pub struct NewOperation {
    pub id: String,
    pub idempotency_key: String,
    pub operation_type: String,
    pub payload: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RecordOutcome<T> {
    Recorded(T),
    /// This idempotency_key was already logged by an earlier attempt — the write
    /// closure was *not* called this time, since whatever it would have done already
    /// happened (atomically) under that earlier attempt.
    AlreadyRecorded,
}

/// Runs `write` and appends `operation`'s log row in one transaction, short-circuiting
/// (without calling `write` at all) if `operation.idempotency_key` has already been
/// recorded. `E` only needs `From<rusqlite::Error>` — the same bound every other
/// error type in this crate already satisfies — so a real business-write module can
/// use its own error type here without wrapping this one.
pub fn record_once<T, E, F>(conn: &mut Connection, operation: NewOperation, write: F) -> Result<RecordOutcome<T>, E>
where
    E: From<rusqlite::Error>,
    F: FnOnce(&Transaction) -> Result<T, E>,
{
    let tx = conn.transaction()?;

    let already: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM operation_log WHERE idempotency_key = ?1)",
        [&operation.idempotency_key],
        |row| row.get(0),
    )?;
    if already {
        // Dropping `tx` without committing rolls back — nothing was written, so
        // there's nothing to undo; this is just not re-running `write`.
        return Ok(RecordOutcome::AlreadyRecorded);
    }

    let result = write(&tx)?;

    tx.execute(
        "INSERT INTO operation_log (id, idempotency_key, operation_type, payload) VALUES (?1, ?2, ?3, ?4)",
        (&operation.id, &operation.idempotency_key, &operation.operation_type, &operation.payload),
    )?;
    tx.commit()?;

    Ok(RecordOutcome::Recorded(result))
}

pub struct LoggedOperation {
    pub id: String,
    pub idempotency_key: String,
    pub operation_type: String,
    pub payload: String,
    pub created_at: String,
}

/// Every operation not yet acknowledged by the server — P1-25's sync client is the
/// intended caller; nothing here marks one as synced, since that bookkeeping belongs
/// to whatever sync-attempt/retry shape P1-25 actually needs.
pub fn list_unsynced(conn: &Connection) -> Result<Vec<LoggedOperation>, OperationLogError> {
    let mut stmt = conn.prepare(
        "SELECT id, idempotency_key, operation_type, payload, created_at
         FROM operation_log WHERE synced_at IS NULL ORDER BY created_at",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(LoggedOperation {
                id: row.get(0)?,
                idempotency_key: row.get(1)?,
                operation_type: row.get(2)?,
                payload: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../migrations/0002_operation_log.sql")).unwrap();
        conn.execute_batch("CREATE TABLE widgets (id TEXT PRIMARY KEY, label TEXT NOT NULL);").unwrap();
        conn
    }

    fn op(key: &str) -> NewOperation {
        NewOperation {
            id: new_operation_id(),
            idempotency_key: key.to_string(),
            operation_type: "widget.created".to_string(),
            payload: r#"{"label":"a widget"}"#.to_string(),
        }
    }

    // The wrapped rusqlite::Error only needs to exist to satisfy record_once's
    // `E: From<rusqlite::Error>` bound in these tests — nothing here reads it back out.
    #[derive(Debug)]
    struct WidgetError(#[allow(dead_code)] rusqlite::Error);
    impl From<rusqlite::Error> for WidgetError {
        fn from(e: rusqlite::Error) -> Self {
            WidgetError(e)
        }
    }

    #[test]
    fn new_operation_id_returns_a_version_7_uuid() {
        let id = new_operation_id();
        let parsed = uuid::Uuid::parse_str(&id).unwrap();
        assert_eq!(parsed.get_version_num(), 7);
    }

    #[test]
    fn records_the_write_and_the_log_row_together() {
        let mut conn = test_conn();
        let operation = op("widget-1");
        let expected_id = operation.id.clone();
        let outcome = record_once::<_, WidgetError, _>(&mut conn, operation, |tx| {
            tx.execute("INSERT INTO widgets (id, label) VALUES ('w1', 'a widget')", [])?;
            Ok(42)
        })
        .unwrap();
        assert_eq!(outcome, RecordOutcome::Recorded(42));

        let widget_count: i64 = conn.query_row("SELECT count(*) FROM widgets", [], |r| r.get(0)).unwrap();
        assert_eq!(widget_count, 1);

        let logged = list_unsynced(&conn).unwrap();
        assert_eq!(logged.len(), 1);
        assert_eq!(logged[0].id, expected_id);
        assert_eq!(logged[0].idempotency_key, "widget-1");
        assert_eq!(logged[0].operation_type, "widget.created");
        assert_eq!(logged[0].payload, r#"{"label":"a widget"}"#);
        assert!(!logged[0].created_at.is_empty());
    }

    #[test]
    fn retrying_the_same_idempotency_key_does_not_rerun_the_write_or_duplicate_the_log_row() {
        let mut conn = test_conn();
        record_once::<_, WidgetError, _>(&mut conn, op("widget-2"), |tx| {
            tx.execute("INSERT INTO widgets (id, label) VALUES ('w2', 'a widget')", [])?;
            Ok(())
        })
        .unwrap();

        let mut write_ran_again = false;
        let outcome = record_once::<_, WidgetError, _>(&mut conn, op("widget-2"), |tx| {
            write_ran_again = true;
            tx.execute("INSERT INTO widgets (id, label) VALUES ('w2-duplicate', 'a widget')", [])?;
            Ok(())
        })
        .unwrap();

        assert_eq!(outcome, RecordOutcome::AlreadyRecorded);
        assert!(!write_ran_again);

        let widget_count: i64 = conn.query_row("SELECT count(*) FROM widgets", [], |r| r.get(0)).unwrap();
        assert_eq!(widget_count, 1, "the second attempt's write must never have run");

        let logged = list_unsynced(&conn).unwrap();
        assert_eq!(logged.len(), 1, "only one log row for one idempotency key, no matter how many retries");
    }

    #[test]
    fn a_failed_write_leaves_neither_the_business_row_nor_the_log_row_behind() {
        let mut conn = test_conn();
        let result = record_once::<(), WidgetError, _>(&mut conn, op("widget-3"), |tx| {
            tx.execute("INSERT INTO widgets (id, label) VALUES ('w3', 'a widget')", [])?;
            // Same primary key again, inside the same transaction — forces a failure
            // *after* the business write already ran, to prove the whole transaction
            // (business write + log row) rolls back together, not just the log half.
            tx.execute("INSERT INTO widgets (id, label) VALUES ('w3', 'a widget')", [])?;
            Ok(())
        });
        assert!(result.is_err());

        let widget_count: i64 = conn.query_row("SELECT count(*) FROM widgets", [], |r| r.get(0)).unwrap();
        assert_eq!(widget_count, 0);
        assert_eq!(list_unsynced(&conn).unwrap().len(), 0);
    }

    #[test]
    fn list_unsynced_returns_operations_in_created_order() {
        let mut conn = test_conn();
        record_once::<_, WidgetError, _>(&mut conn, op("widget-a"), |_| Ok(())).unwrap();
        record_once::<_, WidgetError, _>(&mut conn, op("widget-b"), |_| Ok(())).unwrap();

        let logged = list_unsynced(&conn).unwrap();
        assert_eq!(logged.iter().map(|o| o.idempotency_key.as_str()).collect::<Vec<_>>(), vec!["widget-a", "widget-b"]);
    }
}
