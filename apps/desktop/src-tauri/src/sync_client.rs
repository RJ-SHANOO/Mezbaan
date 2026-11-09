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
use flate2::write::GzEncoder;
use flate2::Compression;
use rand::Rng;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::io::Write;
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
    device_token: String,
}

impl ReqwestSyncTransport {
    pub fn new(sync_url: String, device_token: String) -> Result<Self, SyncError> {
        let client = reqwest::blocking::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| SyncError::Transport(e.to_string()))?;
        Ok(Self { client, sync_url, device_token })
    }
}

/// Gzips the JSON-encoded batch — P1-35's "compressed batches". A separate, pure
/// function so the round trip is unit-testable without a real HTTP call.
fn compress_batch(batch: &[SyncOperationPayload]) -> Result<Vec<u8>, SyncError> {
    let json = serde_json::to_vec(&SyncBatchRequest { operations: batch }).map_err(|e| SyncError::Transport(e.to_string()))?;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&json).map_err(|e| SyncError::Transport(e.to_string()))?;
    encoder.finish().map_err(|e| SyncError::Transport(e.to_string()))
}

impl SyncTransport for ReqwestSyncTransport {
    fn send_batch(&self, batch: &[SyncOperationPayload]) -> Result<SyncBatchResponse, SyncError> {
        let compressed = compress_batch(batch)?;
        let response = self
            .client
            .post(&self.sync_url)
            .header("x-device-token", &self.device_token)
            .header("Content-Type", "application/json")
            .header("Content-Encoding", "gzip")
            .body(compressed)
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
/// Deliberately has no randomness of its own; see `jittered` for that.
fn backoff_duration(attempt: u32) -> Duration {
    let factor = 2u64.saturating_pow(attempt.saturating_sub(1).min(10));
    let millis = (INITIAL_BACKOFF.as_millis() as u64).saturating_mul(factor);
    Duration::from_millis(millis.min(MAX_BACKOFF.as_millis() as u64))
}

/// P1-35's "random delay so terminals do not all reconnect at once": equal jitter
/// (half the base delay, plus a random amount up to the other half) — a branch-wide
/// outage fails every terminal's batch at close to the same instant, and without
/// jitter they'd all retry on the exact same schedule and hit the server in lockstep
/// the moment connectivity returns. Floors at half of `base` rather than full jitter
/// (0..=base) so a retry is never *faster* than intended, only spread out later.
fn jittered(base: Duration) -> Duration {
    let half_millis = (base.as_millis() as u64) / 2;
    let extra = rand::thread_rng().gen_range(0..=half_millis.max(1));
    Duration::from_millis(half_millis + extra)
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
                    sleep_fn(jittered(backoff_duration(attempt)));
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
    fn jittered_stays_within_half_to_full_of_the_base_duration() {
        let base = Duration::from_millis(1000);
        for _ in 0..200 {
            let result = jittered(base);
            assert!(result >= Duration::from_millis(500), "{result:?} was below half of base");
            assert!(result <= base, "{result:?} exceeded base");
        }
    }

    #[test]
    fn jittered_actually_varies_rather_than_returning_a_fixed_value() {
        let base = Duration::from_millis(1000);
        let samples: std::collections::HashSet<_> = (0..50).map(|_| jittered(base)).collect();
        assert!(samples.len() > 1, "200 samples should not all land on the exact same value");
    }

    #[test]
    fn compress_batch_round_trips_through_gzip_back_to_the_original_json() {
        use std::io::Read;

        let batch = vec![SyncOperationPayload {
            id: "op-1".to_string(),
            idempotency_key: "op-1".to_string(),
            operation_type: "widget.created".to_string(),
            payload: r#"{"label":"a widget"}"#.to_string(),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
        }];

        let compressed = compress_batch(&batch).unwrap();
        // Smaller than the equivalent uncompressed JSON would be, for a batch with
        // this much repeated structure — proves it's actually compressed, not just
        // re-encoded.
        let uncompressed_len = serde_json::to_vec(&SyncBatchRequest { operations: &batch }).unwrap().len();
        assert!(compressed.len() < uncompressed_len);

        let mut decoder = flate2::read::GzDecoder::new(&compressed[..]);
        let mut decompressed = String::new();
        decoder.read_to_string(&mut decompressed).unwrap();
        assert_eq!(decompressed, serde_json::to_string(&SyncBatchRequest { operations: &batch }).unwrap());
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

    /// P1-31: a single scenario combining three of the fault categories the exit gate
    /// requires — a large backlog (standing in for "offline several days"), a lost
    /// connection partway through (exhausts retries on one batch, standing in for a
    /// crash mid-sync), and resuming afterward. Proves every operation syncs exactly
    /// once: nothing already-synced is resent, and nothing after the failure point is
    /// lost.
    #[test]
    fn survives_a_lost_connection_partway_through_a_large_offline_backlog() {
        let mut conn = test_conn();
        let total_ops = BATCH_SIZE * 3 + 7; // 4 batches: 50, 50, 50, 7
        let ids: Vec<String> = (0..total_ops).map(|i| format!("op-{i}")).collect();
        for id in &ids {
            seed_operation(&conn, id);
        }
        let batch = |range: std::ops::Range<usize>| -> Vec<&str> { ids[range].iter().map(String::as_str).collect() };

        // Cycle 1: the first batch goes through, then the connection is lost for good
        // on the second — the cycle errors out before ever touching batches 3 and 4.
        let mut first_cycle_responses = vec![Ok(accepted(&batch(0..BATCH_SIZE)))];
        first_cycle_responses.extend((0..MAX_ATTEMPTS).map(|_| Err(SyncError::Transport("connection lost".to_string()))));
        let first_cycle_transport = MockTransport::queue(first_cycle_responses);
        let result = run_sync_cycle_with_sleep(&mut conn, &first_cycle_transport, no_sleep);
        assert!(result.is_err(), "the cycle should stop at the lost-connection batch, not silently skip it");
        assert_eq!(operation_log::list_unsynced(&conn).unwrap().len(), total_ops - BATCH_SIZE);

        // Cycle 2 (after "restart"): a fresh transport recovers and drains the rest —
        // batch 1's operations are never sent again.
        let second_cycle_transport = MockTransport::queue(vec![
            Ok(accepted(&batch(BATCH_SIZE..BATCH_SIZE * 2))),
            Ok(accepted(&batch(BATCH_SIZE * 2..BATCH_SIZE * 3))),
            Ok(accepted(&batch(BATCH_SIZE * 3..total_ops))),
        ]);
        let summary = run_sync_cycle_with_sleep(&mut conn, &second_cycle_transport, no_sleep).unwrap();

        assert_eq!(summary.synced_count as usize, total_ops - BATCH_SIZE);
        assert_eq!(operation_log::list_unsynced(&conn).unwrap().len(), 0);
        let resent_batch_one = second_cycle_transport.calls.borrow().iter().any(|call| call.iter().any(|op| op.id == "op-0"));
        assert!(!resent_batch_one, "an already-synced operation must never be sent again");
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
