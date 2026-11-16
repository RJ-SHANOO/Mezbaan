//! P2-32: a persistent local print queue on top of P2-31's transport layer.
//! Enqueueing is a plain SQLite insert — it survives a crash or restart the
//! same way operation_log's writes do (rule 13). Actually sending a job
//! never happens while the local database's mutex is held (see
//! printer_commands.rs's `process_print_queue`): `claim_due_jobs` and the
//! two outcome-recording functions below are each a short, separate SQL
//! statement, so a slow or hung printer (rule 15's timeout bounds how slow,
//! but never to zero) can never block every other local DB read/write in
//! the app — rule 14's "a printer failure must never block a sale."
//!
//! Retry follows the same shape as the server's outbox (P1-30): capped
//! attempts, then `dead_letter`, with exponential backoff between retries
//! in between. A reprint (`enqueue_reprint`) is a distinct job from the
//! original — it re-renders the same bytes with a "*** COPY ***" banner
//! prepended via escpos.rs, so the physical printout itself is marked, not
//! just a database flag nobody but a report would ever see.

use crate::escpos::ReceiptBuilder;
use crate::printer_transport::PrinterConnectionConfig;
use rusqlite::{params, Connection};
use std::fmt;
use std::time::Duration;

const DEFAULT_MAX_ATTEMPTS: i64 = 5;
const BASE_BACKOFF: Duration = Duration::from_secs(5);
const MAX_BACKOFF: Duration = Duration::from_secs(300);

#[derive(Debug)]
pub struct PrintQueueError(String);

impl fmt::Display for PrintQueueError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "print queue error: {}", self.0)
    }
}

impl std::error::Error for PrintQueueError {}

impl From<rusqlite::Error> for PrintQueueError {
    fn from(e: rusqlite::Error) -> Self {
        PrintQueueError(e.to_string())
    }
}

impl From<serde_json::Error> for PrintQueueError {
    fn from(e: serde_json::Error) -> Self {
        PrintQueueError(format!("failed to (de)serialize printer connection: {e}"))
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintJobRecord {
    pub id: String,
    pub status: String,
    pub attempts: i64,
    pub max_attempts: i64,
    pub last_error: Option<String>,
    pub is_copy: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// A job pulled off the queue and ready to actually send — deliberately
/// carries no DB connection or lock of its own, so the caller can send it
/// with the database fully unlocked.
pub struct ClaimedJob {
    pub id: String,
    pub connection: PrinterConnectionConfig,
    pub data: Vec<u8>,
    pub attempts: i64,
    pub max_attempts: i64,
}

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueStatusSummary {
    pub pending: i64,
    pub printing: i64,
    pub failed: i64,
    pub dead_letter: i64,
    pub done: i64,
}

pub fn enqueue(conn: &Connection, connection: &PrinterConnectionConfig, data: &[u8]) -> Result<String, PrintQueueError> {
    insert_job(conn, connection, data, false)
}

/// Re-renders `original_data` with a "*** COPY ***" banner (escpos.rs) and
/// enqueues that as its own job — the printout itself says it's a copy,
/// not only a database flag.
pub fn enqueue_reprint(conn: &Connection, connection: &PrinterConnectionConfig, original_data: &[u8]) -> Result<String, PrintQueueError> {
    let marked = ReceiptBuilder::new()
        .line("*** COPY ***")
        .build()
        .into_iter()
        .chain(original_data.iter().copied())
        .collect::<Vec<u8>>();
    insert_job(conn, connection, &marked, true)
}

fn insert_job(conn: &Connection, connection: &PrinterConnectionConfig, data: &[u8], is_copy: bool) -> Result<String, PrintQueueError> {
    let id = uuid::Uuid::now_v7().to_string();
    let connection_json = serde_json::to_string(connection)?;
    conn.execute(
        "INSERT INTO print_jobs (id, printer_connection, data, max_attempts, is_copy) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, connection_json, data, DEFAULT_MAX_ATTEMPTS, is_copy as i64],
    )?;
    Ok(id)
}

/// Marks up to `limit` due jobs (`pending`, or `failed` whose backoff has
/// elapsed) as `printing` and returns them — the "claim" step. Two
/// statements, not one atomic `UPDATE ... RETURNING`, to stay portable
/// across whatever SQLite version this app's rusqlite build ships; this is
/// a single local connection behind the app's own mutex, so there's no
/// concurrent claimer to race against in the first place.
pub fn claim_due_jobs(conn: &Connection, limit: i64) -> Result<Vec<ClaimedJob>, PrintQueueError> {
    let mut stmt = conn.prepare(
        "SELECT id FROM print_jobs
         WHERE status = 'pending' OR (status = 'failed' AND next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ORDER BY created_at ASC
         LIMIT ?1",
    )?;
    let ids: Vec<String> = stmt.query_map([limit], |row| row.get(0))?.collect::<Result<_, _>>()?;
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut claimed = Vec::with_capacity(ids.len());
    for id in ids {
        conn.execute("UPDATE print_jobs SET status = 'printing', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1", [&id])?;
        let (connection_json, data, attempts, max_attempts): (String, Vec<u8>, i64, i64) = conn.query_row(
            "SELECT printer_connection, data, attempts, max_attempts FROM print_jobs WHERE id = ?1",
            [&id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        let connection: PrinterConnectionConfig = serde_json::from_str(&connection_json)?;
        claimed.push(ClaimedJob { id, connection, data, attempts, max_attempts });
    }
    Ok(claimed)
}

pub fn mark_succeeded(conn: &Connection, job_id: &str) -> Result<(), PrintQueueError> {
    conn.execute(
        "UPDATE print_jobs SET status = 'done', last_error = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
        [job_id],
    )?;
    Ok(())
}

/// Increments the attempt count and either schedules the next retry
/// (exponential backoff, capped) or — once `max_attempts` is reached —
/// moves the job to `dead_letter`, where it sits for a human to see via
/// `queue_status`/`list_jobs` rather than retrying forever.
pub fn mark_failed(conn: &Connection, job_id: &str, error: &str) -> Result<(), PrintQueueError> {
    let (attempts, max_attempts): (i64, i64) = conn.query_row("SELECT attempts, max_attempts FROM print_jobs WHERE id = ?1", [job_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
    let new_attempts = attempts + 1;

    if new_attempts >= max_attempts {
        conn.execute(
            "UPDATE print_jobs SET status = 'dead_letter', attempts = ?2, last_error = ?3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
            params![job_id, new_attempts, error],
        )?;
    } else {
        let backoff = backoff_for_attempt(new_attempts);
        conn.execute(
            "UPDATE print_jobs
             SET status = 'failed', attempts = ?2, last_error = ?3,
                 next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', ?4)),
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1",
            params![job_id, new_attempts, error, format!("+{} seconds", backoff.as_secs())],
        )?;
    }
    Ok(())
}

fn backoff_for_attempt(attempt: i64) -> Duration {
    let secs = BASE_BACKOFF.as_secs().saturating_mul(1u64.wrapping_shl(attempt.min(10) as u32).max(1));
    Duration::from_secs(secs).min(MAX_BACKOFF)
}

pub fn queue_status(conn: &Connection) -> Result<QueueStatusSummary, PrintQueueError> {
    let mut summary = QueueStatusSummary::default();
    let mut stmt = conn.prepare("SELECT status, COUNT(*) FROM print_jobs GROUP BY status")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
    for row in rows {
        let (status, count) = row?;
        match status.as_str() {
            "pending" => summary.pending = count,
            "printing" => summary.printing = count,
            "failed" => summary.failed = count,
            "dead_letter" => summary.dead_letter = count,
            "done" => summary.done = count,
            _ => {}
        }
    }
    Ok(summary)
}

pub fn list_jobs(conn: &Connection, status_filter: Option<&str>, limit: i64) -> Result<Vec<PrintJobRecord>, PrintQueueError> {
    let mut stmt = match status_filter {
        Some(_) => conn.prepare("SELECT id, status, attempts, max_attempts, last_error, is_copy, created_at, updated_at FROM print_jobs WHERE status = ?1 ORDER BY created_at DESC LIMIT ?2")?,
        None => conn.prepare("SELECT id, status, attempts, max_attempts, last_error, is_copy, created_at, updated_at FROM print_jobs ORDER BY created_at DESC LIMIT ?1")?,
    };

    let map_row = |row: &rusqlite::Row| -> rusqlite::Result<PrintJobRecord> {
        Ok(PrintJobRecord {
            id: row.get(0)?,
            status: row.get(1)?,
            attempts: row.get(2)?,
            max_attempts: row.get(3)?,
            last_error: row.get(4)?,
            is_copy: row.get::<_, i64>(5)? != 0,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
        })
    };

    let rows = match status_filter {
        Some(status) => stmt.query_map(params![status, limit], map_row)?.collect::<Result<Vec<_>, _>>()?,
        None => stmt.query_map([limit], map_row)?.collect::<Result<Vec<_>, _>>()?,
    };
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::printer_transport::PrinterConnectionConfig;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../migrations/0007_print_queue.sql")).unwrap();
        conn
    }

    fn network_config() -> PrinterConnectionConfig {
        PrinterConnectionConfig::Network { host: "127.0.0.1".to_string(), port: 9100, timeout_ms: 1000 }
    }

    #[test]
    fn enqueue_inserts_a_pending_job() {
        let conn = test_conn();
        let id = enqueue(&conn, &network_config(), b"hello").unwrap();
        let jobs = list_jobs(&conn, None, 10).unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].id, id);
        assert_eq!(jobs[0].status, "pending");
        assert!(!jobs[0].is_copy);
    }

    #[test]
    fn enqueue_reprint_marks_the_job_as_a_copy() {
        let conn = test_conn();
        enqueue_reprint(&conn, &network_config(), b"original receipt").unwrap();
        let jobs = list_jobs(&conn, None, 10).unwrap();
        assert!(jobs[0].is_copy);

        let data: Vec<u8> = conn.query_row("SELECT data FROM print_jobs WHERE id = ?1", [&jobs[0].id], |r| r.get(0)).unwrap();
        let text = String::from_utf8_lossy(&data);
        assert!(text.contains("*** COPY ***"));
        assert!(text.contains("original receipt"));
    }

    #[test]
    fn claim_due_jobs_marks_them_printing_and_returns_their_bytes() {
        let conn = test_conn();
        enqueue(&conn, &network_config(), b"job-1").unwrap();

        let claimed = claim_due_jobs(&conn, 10).unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].data, b"job-1");

        let jobs = list_jobs(&conn, None, 10).unwrap();
        assert_eq!(jobs[0].status, "printing");
    }

    #[test]
    fn claim_due_jobs_does_not_reclaim_an_already_printing_job() {
        let conn = test_conn();
        enqueue(&conn, &network_config(), b"job-1").unwrap();
        claim_due_jobs(&conn, 10).unwrap();

        let second_claim = claim_due_jobs(&conn, 10).unwrap();
        assert!(second_claim.is_empty());
    }

    #[test]
    fn mark_succeeded_sets_status_done() {
        let conn = test_conn();
        let id = enqueue(&conn, &network_config(), b"job-1").unwrap();
        claim_due_jobs(&conn, 10).unwrap();

        mark_succeeded(&conn, &id).unwrap();

        let jobs = list_jobs(&conn, None, 10).unwrap();
        assert_eq!(jobs[0].status, "done");
    }

    #[test]
    fn mark_failed_retries_until_max_attempts_then_dead_letters() {
        let conn = test_conn();
        let id = enqueue(&conn, &network_config(), b"job-1").unwrap();
        conn.execute("UPDATE print_jobs SET max_attempts = 2 WHERE id = ?1", [&id]).unwrap();

        claim_due_jobs(&conn, 10).unwrap();
        mark_failed(&conn, &id, "connection refused").unwrap();
        let after_first = list_jobs(&conn, None, 10).unwrap();
        assert_eq!(after_first[0].status, "failed");
        assert_eq!(after_first[0].attempts, 1);
        assert_eq!(after_first[0].last_error.as_deref(), Some("connection refused"));

        // Second failure hits max_attempts (2) — dead_letter, not another retry.
        conn.execute("UPDATE print_jobs SET status = 'printing' WHERE id = ?1", [&id]).unwrap();
        mark_failed(&conn, &id, "timed out").unwrap();
        let after_second = list_jobs(&conn, None, 10).unwrap();
        assert_eq!(after_second[0].status, "dead_letter");
        assert_eq!(after_second[0].attempts, 2);
    }

    #[test]
    fn a_freshly_failed_job_is_not_immediately_due_for_retry() {
        let conn = test_conn();
        let id = enqueue(&conn, &network_config(), b"job-1").unwrap();
        claim_due_jobs(&conn, 10).unwrap();
        mark_failed(&conn, &id, "boom").unwrap();

        // next_attempt_at is seconds in the future — not due yet.
        let claimed = claim_due_jobs(&conn, 10).unwrap();
        assert!(claimed.is_empty());
    }

    #[test]
    fn queue_status_counts_by_status() {
        let conn = test_conn();
        let a = enqueue(&conn, &network_config(), b"a").unwrap();
        enqueue(&conn, &network_config(), b"b").unwrap();
        claim_due_jobs(&conn, 10).unwrap();
        mark_succeeded(&conn, &a).unwrap();

        let status = queue_status(&conn).unwrap();
        assert_eq!(status.done, 1);
        assert_eq!(status.printing, 1);
    }
}
