//! The sync client (P1-25): reads not-yet-acknowledged rows from operation_log,
//! sends them to the server in ordered batches, retries a failed batch with
//! exponential backoff, and marks each accepted operation synced only once the
//! server actually says so.
//!
//! "Resume after a crash" needs no special-case code here: nothing is marked synced
//! until the server acks it (rule 11: financial/operational events merge by
//! appending), so a crash mid-cycle just means the next run picks the exact same
//! unsynced rows back up from operation_log — same as any other run.
//!
//! There's no server endpoint to talk to yet (P1-26), so `SyncTransport` is a trait:
//! `ReqwestSyncTransport` is the real one, and tests drive the retry/batching logic
//! against an in-memory mock instead of a live server.
use crate::operation_log::{self, LoggedOperation};
use crate::sync_status;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::time::Duration;

const BATCH_SIZE: usize = 50;
const MAX_ATTEMPTS: u32 = 5;
const INITIAL_BACKOFF: Duration = Duration::from_millis(500);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// Rule 15: every network call has a timeout.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub enum SyncError {
    Db(operation_log::OperationLogError),
    Transport(String),
}

impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SyncError::Db(e) => write!(f, "sync: local database error: {e}"),
            SyncError::Transport(detail) => write!(f, "sync: transport error: {detail}"),
        }
    }
}

impl std::error::Error for SyncError {}

impl From<operation_log::OperationLogError> for SyncError {
    fn from(e: operation_log::OperationLogError) -> Self {
        SyncError::Db(e)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncOperationPayload {
    pub id: String,
    pub idempotency_key: String,
    pub operation_type: String,
    // The caller's JSON, passed through as a string (double-encoded on the wire)
    // rather than embedded as a raw JSON value — simplest correct option; the
    // server (P1-26) parses this string when it needs to.
    pub payload: String,
    pub created_at: String,
}

impl From<LoggedOperation> for SyncOperationPayload {
    fn from(op: LoggedOperation) -> Self {
        SyncOperationPayload {
            id: op.id,
            idempotency_key: op.idempotency_key,
            operation_type: op.operation_type,
            payload: op.payload,
            created_at: op.created_at,
        }
    }
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncStatus {
    Accepted,
    Rejected,
}

#[derive(Debug, Deserialize)]
pub struct SyncOperationResult {
    pub id: String,
    pub status: SyncStatus,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SyncBatchResponse {
    pub results: Vec<SyncOperationResult>,
}

#[derive(Debug, Serialize)]
struct SyncBatchRequest<'a> {
    operations: &'a [SyncOperationPayload],
}

#[derive(Debug, PartialEq, Eq, Default)]
pub struct SyncCycleSummary {
    pub synced_count: u32,
    pub rejected_count: u32,
}

pub trait SyncTransport {
    fn send_batch(&self, batch: &[SyncOperationPayload]) -> Result<SyncBatchResponse, SyncError>;
}

pub struct ReqwestSyncTransport {
    client: reqwest::blocking::Client,
    sync_url: String,
}

impl ReqwestSyncTransport {
    pub fn new(sync_url: String) -> Result<Self, SyncError> {
        let client = reqwest::blocking::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| SyncError::Transport(e.to_string()))?;
        Ok(Self { client, sync_url })
    }
}

impl SyncTransport for ReqwestSyncTransport {
    fn send_batch(&self, batch: &[SyncOperationPayload]) -> Result<SyncBatchResponse, SyncError> {
        let response = self
            .client
            .post(&self.sync_url)
            .json(&SyncBatchRequest { operations: batch })
            .send()
            .map_err(|e| SyncError::Transport(e.to_string()))?;

        if !response.status().is_success() {
            return Err(SyncError::Transport(format!("sync endpoint returned {}", response.status())));
        }
        response.json::<SyncBatchResponse>().map_err(|e| SyncError::Transport(e.to_string()))
    }
}

/// `attempt` is 1-based. Doubles each attempt, capped at MAX_BACKOFF — separated out
/// from the retry loop purely so it's unit-testable without actually sleeping.
fn backoff_duration(attempt: u32) -> Duration {
    let factor = 2u64.saturating_pow(attempt.saturating_sub(1).min(10));
    let millis = (INITIAL_BACKOFF.as_millis() as u64).saturating_mul(factor);
    Duration::from_millis(millis.min(MAX_BACKOFF.as_millis() as u64))
}

fn send_with_retry<T: SyncTransport>(
    transport: &T,
    batch: &[SyncOperationPayload],
    sleep_fn: &impl Fn(Duration),
) -> Result<SyncBatchResponse, SyncError> {
    let mut last_err = None;
    for attempt in 1..=MAX_ATTEMPTS {
        match transport.send_batch(batch) {
            Ok(response) => return Ok(response),
            Err(e) => {
                last_err = Some(e);
                if attempt < MAX_ATTEMPTS {
                    sleep_fn(backoff_duration(attempt));
                }
            }
        }
    }
    Err(last_err.expect("loop ran at least once, so an error was always recorded"))
}

/// Runs one sync cycle: batches every unsynced operation, sends each batch in order
/// (retrying with backoff on transport failure), and marks accepted operations
/// synced as the server confirms them. Stops at the first batch that exhausts all
/// retries, leaving it and everything after it unsynced for the next cycle — never
/// sends a later batch out of order ahead of one that hasn't actually gone through.
pub fn run_sync_cycle<T: SyncTransport>(conn: &mut Connection, transport: &T) -> Result<SyncCycleSummary, SyncError> {
    let result = run_sync_cycle_with_sleep(conn, transport, std::thread::sleep);
    // P1-29's sync status indicator: record whether this cycle actually reached the
    // server, independent of the summary itself. Best-effort — a failure to record
    // status must never turn an otherwise-successful sync into a reported failure.
    if let Err(err) = sync_status::record_sync_attempt(conn, result.is_ok()) {
        log::error!("sync: failed to record sync status: {err}");
    }
    result
}

fn run_sync_cycle_with_sleep<T: SyncTransport>(
    conn: &mut Connection,
    transport: &T,
    sleep_fn: impl Fn(Duration),
) -> Result<SyncCycleSummary, SyncError> {
    let pending = operation_log::list_unsynced(conn)?;
    let payloads: Vec<SyncOperationPayload> = pending.into_iter().map(SyncOperationPayload::from).collect();

    let mut summary = SyncCycleSummary::default();
    for batch in payloads.chunks(BATCH_SIZE) {
        let response = send_with_retry(transport, batch, &sleep_fn)?;
        for result in response.results {
            match result.status {
                SyncStatus::Accepted => {
                    operation_log::mark_synced(conn, &result.id)?;
                    summary.synced_count += 1;
                }
                SyncStatus::Rejected => {
                    // Left unsynced on purpose: a server-side rejection (e.g. failed
                    // validation) won't start succeeding on a later retry of the same
                    // payload. A real dead-letter flow is a later concern — there's
                    // no server that can reject something meaningfully yet (P1-26).
                    log::warn!("sync: server rejected operation {}: {:?}", result.id, result.reason);
                    summary.rejected_count += 1;
                }
            }
        }
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../migrations/0002_operation_log.sql")).unwrap();
        conn
    }

    fn seed_operation(conn: &Connection, idempotency_key: &str) {
        conn.execute(
            "INSERT INTO operation_log (id, idempotency_key, operation_type, payload) VALUES (?1, ?1, ?2, '{}')",
            (idempotency_key, "widget.created"),
        )
        .unwrap();
    }

    fn accepted(ids: &[&str]) -> SyncBatchResponse {
        SyncBatchResponse {
            results: ids.iter().map(|id| SyncOperationResult { id: id.to_string(), status: SyncStatus::Accepted, reason: None }).collect(),
        }
    }

    struct MockTransport {
        responses: RefCell<Vec<Result<SyncBatchResponse, SyncError>>>,
        calls: RefCell<Vec<Vec<SyncOperationPayload>>>,
    }

    impl MockTransport {
        fn queue(responses: Vec<Result<SyncBatchResponse, SyncError>>) -> Self {
            MockTransport { responses: RefCell::new(responses), calls: RefCell::new(Vec::new()) }
        }
    }

    impl SyncTransport for MockTransport {
        fn send_batch(&self, batch: &[SyncOperationPayload]) -> Result<SyncBatchResponse, SyncError> {
            self.calls.borrow_mut().push(batch.to_vec());
            if self.responses.borrow().is_empty() {
                panic!("MockTransport: send_batch called more times than responses were queued");
            }
            self.responses.borrow_mut().remove(0)
        }
    }

    fn no_sleep(_: Duration) {}

    #[test]
    fn backoff_doubles_each_attempt_up_to_a_cap() {
        assert_eq!(backoff_duration(1), Duration::from_millis(500));
        assert_eq!(backoff_duration(2), Duration::from_millis(1000));
        assert_eq!(backoff_duration(3), Duration::from_millis(2000));
        assert_eq!(backoff_duration(20), MAX_BACKOFF);
    }

    #[test]
    fn an_empty_log_makes_no_network_call_at_all() {
        let mut conn = test_conn();
        let transport = MockTransport::queue(vec![]);

        let summary = run_sync_cycle_with_sleep(&mut conn, &transport, no_sleep).unwrap();

        assert_eq!(summary, SyncCycleSummary::default());
        assert_eq!(transport.calls.borrow().len(), 0);
    }

    #[test]
    fn accepted_operations_are_marked_synced_and_leave_the_unsynced_list() {
        let mut conn = test_conn();
        seed_operation(&conn, "op-1");
        seed_operation(&conn, "op-2");
        let transport = MockTransport::queue(vec![Ok(accepted(&["op-1", "op-2"]))]);

        let summary = run_sync_cycle_with_sleep(&mut conn, &transport, no_sleep).unwrap();

        assert_eq!(summary, SyncCycleSummary { synced_count: 2, rejected_count: 0 });
        assert_eq!(operation_log::list_unsynced(&conn).unwrap().len(), 0);
    }

    #[test]
    fn a_rejected_operation_stays_unsynced() {
        let mut conn = test_conn();
        seed_operation(&conn, "op-1");
        let transport = MockTransport::queue(vec![Ok(SyncBatchResponse {
            results: vec![SyncOperationResult { id: "op-1".to_string(), status: SyncStatus::Rejected, reason: Some("bad payload".to_string()) }],
        })]);

        let summary = run_sync_cycle_with_sleep(&mut conn, &transport, no_sleep).unwrap();

        assert_eq!(summary, SyncCycleSummary { synced_count: 0, rejected_count: 1 });
        assert_eq!(operation_log::list_unsynced(&conn).unwrap().len(), 1);
    }

    #[test]
    fn more_than_one_batch_worth_of_operations_is_sent_in_chunks() {
        let mut conn = test_conn();
        let ids: Vec<String> = (0..(BATCH_SIZE + 5)).map(|i| format!("op-{i}")).collect();
        for id in &ids {
            seed_operation(&conn, id);
        }
        let first_batch_ids: Vec<&str> = ids[..BATCH_SIZE].iter().map(String::as_str).collect();
        let second_batch_ids: Vec<&str> = ids[BATCH_SIZE..].iter().map(String::as_str).collect();
        let transport = MockTransport::queue(vec![Ok(accepted(&first_batch_ids)), Ok(accepted(&second_batch_ids))]);

        let summary = run_sync_cycle_with_sleep(&mut conn, &transport, no_sleep).unwrap();

        assert_eq!(summary.synced_count as usize, ids.len());
        let calls = transport.calls.borrow();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].len(), BATCH_SIZE);
        assert_eq!(calls[1].len(), 5);
    }

    #[test]
    fn a_transport_failure_is_retried_and_recovers() {
        let mut conn = test_conn();
        seed_operation(&conn, "op-1");
        let transport = MockTransport::queue(vec![
            Err(SyncError::Transport("timeout".to_string())),
            Err(SyncError::Transport("timeout".to_string())),
            Ok(accepted(&["op-1"])),
        ]);

        let summary = run_sync_cycle_with_sleep(&mut conn, &transport, no_sleep).unwrap();

        assert_eq!(summary, SyncCycleSummary { synced_count: 1, rejected_count: 0 });
        assert_eq!(transport.calls.borrow().len(), 3);
    }

    #[test]
    fn exhausting_every_retry_leaves_the_operation_unsynced_for_the_next_cycle() {
        let mut conn = test_conn();
        seed_operation(&conn, "op-1");
        let always_fails = MockTransport::queue((0..MAX_ATTEMPTS).map(|_| Err(SyncError::Transport("down".to_string()))).collect());

        let result = run_sync_cycle_with_sleep(&mut conn, &always_fails, no_sleep);
        assert!(result.is_err());
        assert_eq!(operation_log::list_unsynced(&conn).unwrap().len(), 1);

        // A fresh cycle (the "resume after a crash" case) picks the same operation
        // back up and, once the transport is healthy again, succeeds.
        let recovered = MockTransport::queue(vec![Ok(accepted(&["op-1"]))]);
        let summary = run_sync_cycle_with_sleep(&mut conn, &recovered, no_sleep).unwrap();
        assert_eq!(summary, SyncCycleSummary { synced_count: 1, rejected_count: 0 });
        assert_eq!(operation_log::list_unsynced(&conn).unwrap().len(), 0);
    }
}
