//! Offline manager-PIN verification (P1-27b): once a snapshot from P1-27 has been
//! fetched and its signature verified (snapshot_sync.rs), this ingests the staff
//! list (with PIN hashes) and verifies a manager's PIN against it with no server
//! round-trip — same scrypt algorithm/parameters and the same lockout rule
//! (packages/nest-core/src/manager-pin.service.ts, password.ts) as the online path,
//! so a manager who's locked out offline stays locked out if they're later approved
//! online, and vice versa isn't assumed either way — this tracks its own counter
//! because there's nothing to ask the server while offline.
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use std::fmt;

const MAX_FAILED_ATTEMPTS: i64 = 5;
const LOCKOUT_MINUTES: i64 = 15;

#[derive(Debug)]
pub enum OfflinePinError {
    Db(rusqlite::Error),
    Parse(String),
}

impl fmt::Display for OfflinePinError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OfflinePinError::Db(e) => write!(f, "offline PIN storage error: {e}"),
            OfflinePinError::Parse(detail) => write!(f, "offline PIN: couldn't parse snapshot content: {detail}"),
        }
    }
}

impl std::error::Error for OfflinePinError {}

impl From<rusqlite::Error> for OfflinePinError {
    fn from(e: rusqlite::Error) -> Self {
        OfflinePinError::Db(e)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum PinVerifyOutcome {
    Approved,
    /// No such user, inactive, no PIN set, or wrong PIN (not yet locked) — same as
    /// the online path, these all look identical to the caller.
    Denied,
    Locked,
}

#[derive(Deserialize)]
struct SnapshotStaffMember {
    id: String,
    #[serde(rename = "displayName")]
    display_name: String,
    email: String,
    #[serde(rename = "roleKey")]
    role_key: String,
    #[serde(rename = "branchId")]
    branch_id: Option<String>,
    status: String,
    #[serde(rename = "pinHash")]
    pin_hash: Option<String>,
}

#[derive(Deserialize)]
struct SnapshotContent {
    staff: Vec<SnapshotStaffMember>,
}

/// Wholesale replace (rule 11: for settings-like data, the server's version wins) —
/// never a merge. Doesn't touch offline_pin_lockout: a refreshed PIN hash shouldn't
/// silently clear an existing local lockout.
pub fn ingest_snapshot(conn: &mut Connection, version: &str, content_json: &str) -> Result<usize, OfflinePinError> {
    let content: SnapshotContent = serde_json::from_str(content_json).map_err(|e| OfflinePinError::Parse(e.to_string()))?;

    let tx = conn.transaction()?;
    tx.execute("DELETE FROM offline_staff", [])?;
    for member in &content.staff {
        tx.execute(
            "INSERT INTO offline_staff (user_id, display_name, email, role_key, branch_id, status, pin_hash, snapshot_version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            (&member.id, &member.display_name, &member.email, &member.role_key, &member.branch_id, &member.status, &member.pin_hash, version),
        )?;
    }
    let count = content.staff.len();
    tx.commit()?;
    Ok(count)
}

/// Checks `user_id`'s current lockout state and, if unlocked, verifies `pin` against
/// their synced hash — updating the local lockout counter exactly like
/// ManagerPinService.approve() updates its server-side one. Does not check role
/// permissions (that's server-side, P1-12, with no offline equivalent to replicate
/// yet) — only the PIN itself and its lockout state, per this task's scope.
pub fn verify_pin(conn: &Connection, user_id: &str, pin: &str) -> Result<PinVerifyOutcome, OfflinePinError> {
    let row: Option<(String, Option<String>, i64)> = conn
        .query_row(
            "SELECT status, pin_hash,
                CASE WHEN EXISTS (
                  SELECT 1 FROM offline_pin_lockout
                  WHERE user_id = ?1 AND locked_until IS NOT NULL AND locked_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                ) THEN 1 ELSE 0 END
             FROM offline_staff WHERE user_id = ?1",
            [user_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;

    let Some((status, pin_hash, is_locked)) = row else {
        return Ok(PinVerifyOutcome::Denied);
    };
    if status != "active" {
        return Ok(PinVerifyOutcome::Denied);
    }
    if is_locked != 0 {
        return Ok(PinVerifyOutcome::Locked);
    }
    let Some(pin_hash) = pin_hash else {
        return Ok(PinVerifyOutcome::Denied);
    };

    if verify_pin_hash(pin, &pin_hash) {
        clear_lockout(conn, user_id)?;
        return Ok(PinVerifyOutcome::Approved);
    }

    let failed_attempts = record_failed_attempt(conn, user_id)?;
    if failed_attempts >= MAX_FAILED_ATTEMPTS {
        Ok(PinVerifyOutcome::Locked)
    } else {
        Ok(PinVerifyOutcome::Denied)
    }
}

fn clear_lockout(conn: &Connection, user_id: &str) -> Result<(), OfflinePinError> {
    conn.execute(
        "INSERT INTO offline_pin_lockout (user_id, failed_attempts, locked_until) VALUES (?1, 0, NULL)
         ON CONFLICT(user_id) DO UPDATE SET failed_attempts = 0, locked_until = NULL",
        [user_id],
    )?;
    Ok(())
}

fn record_failed_attempt(conn: &Connection, user_id: &str) -> Result<i64, OfflinePinError> {
    conn.execute(
        "INSERT INTO offline_pin_lockout (user_id, failed_attempts, locked_until) VALUES (?1, 1, NULL)
         ON CONFLICT(user_id) DO UPDATE SET failed_attempts = failed_attempts + 1",
        [user_id],
    )?;
    let failed_attempts: i64 = conn.query_row("SELECT failed_attempts FROM offline_pin_lockout WHERE user_id = ?1", [user_id], |row| row.get(0))?;
    if failed_attempts >= MAX_FAILED_ATTEMPTS {
        conn.execute(
            &format!(
                "UPDATE offline_pin_lockout SET locked_until = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+{LOCKOUT_MINUTES} minutes') WHERE user_id = ?1"
            ),
            [user_id],
        )?;
    }
    Ok(failed_attempts)
}

/// "salthex:hashhex" — packages/nest-core/src/password.ts's exact encoding.
fn verify_pin_hash(plain: &str, stored: &str) -> bool {
    let Some((salt_hex, hash_hex)) = stored.split_once(':') else { return false };
    let Some(salt) = hex_decode(salt_hex) else { return false };
    let Some(expected) = hex_decode(hash_hex) else { return false };
    let Some(derived) = scrypt_derive(plain, &salt, expected.len()) else { return false };
    constant_time_eq(&derived, &expected)
}

/// N=16384 (log_n=14), r=8, p=1 — Node's crypto.scrypt() defaults, matched exactly.
fn scrypt_derive(plain: &str, salt: &[u8], output_len: usize) -> Option<Vec<u8>> {
    let params = scrypt::Params::new(14, 8, 1, output_len).ok()?;
    let mut output = vec![0u8; output_len];
    scrypt::scrypt(plain.as_bytes(), salt, &params, &mut output).ok()?;
    Some(output)
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../migrations/0003_manager_pin_offline.sql")).unwrap();
        conn
    }

    fn seed_staff(conn: &Connection, user_id: &str, status: &str, pin_hash: Option<&str>) {
        conn.execute(
            "INSERT INTO offline_staff (user_id, display_name, email, role_key, branch_id, status, pin_hash, snapshot_version)
             VALUES (?1, 'Manager', 'm@example.test', 'branch_manager', NULL, ?2, ?3, 'v1')",
            (user_id, status, pin_hash),
        )
        .unwrap();
    }

    /// Generated independently with Node's crypto.scrypt (the exact function
    /// packages/nest-core/src/password.ts uses) against a fixed salt and plaintext —
    /// proves the Rust and Node implementations produce byte-identical output for
    /// the same input, not just that Rust's round-trips with itself.
    const NODE_CROSS_CHECK_HASH: &str =
        "000102030405060708090a0b0c0d0e0f:3a4da9adef76210007b7f003040ccf3e3d0d79d0cce5148a8f3f1835a55459af1b2240225be608b378d15a36b5ff8d8fc78c35e8600b2a7dc4bb5c279d41be56";

    #[test]
    fn verifies_a_real_node_generated_hash() {
        assert!(verify_pin_hash("my-secret-pin", NODE_CROSS_CHECK_HASH));
        assert!(!verify_pin_hash("wrong-pin", NODE_CROSS_CHECK_HASH));
    }

    #[test]
    fn round_trips_a_freshly_derived_hash() {
        let salt = [7u8; 16];
        let derived = scrypt_derive("1234", &salt, 64).unwrap();
        let stored = format!("{}:{}", hex_encode(&salt), hex_encode(&derived));
        assert!(verify_pin_hash("1234", &stored));
        assert!(!verify_pin_hash("4321", &stored));
    }

    fn hex_encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn ingest_snapshot_replaces_staff_wholesale() {
        let mut conn = test_conn();
        seed_staff(&conn, "stale-user", "active", None);

        let content = r#"{"restaurantId":"r1","branches":[],"staff":[
            {"id":"u1","displayName":"Owner","email":"o@example.test","roleKey":"owner","branchId":null,"status":"active","pinHash":"abc:def"}
        ]}"#;
        let count = ingest_snapshot(&mut conn, "v2", content).unwrap();
        assert_eq!(count, 1);

        let remaining: i64 = conn.query_row("SELECT count(*) FROM offline_staff WHERE user_id = 'stale-user'", [], |r| r.get(0)).unwrap();
        assert_eq!(remaining, 0);
        let kept: i64 = conn.query_row("SELECT count(*) FROM offline_staff WHERE user_id = 'u1'", [], |r| r.get(0)).unwrap();
        assert_eq!(kept, 1);
    }

    #[test]
    fn approves_the_correct_pin_and_resets_any_prior_failed_attempts() {
        let conn = test_conn();
        let salt = [1u8; 16];
        let derived = scrypt_derive("1234", &salt, 64).unwrap();
        let hash = format!("{}:{}", hex_encode(&salt), hex_encode(&derived));
        seed_staff(&conn, "u1", "active", Some(&hash));

        assert_eq!(verify_pin(&conn, "u1", "wrong").unwrap(), PinVerifyOutcome::Denied);
        assert_eq!(verify_pin(&conn, "u1", "1234").unwrap(), PinVerifyOutcome::Approved);

        let failed_attempts: i64 = conn.query_row("SELECT failed_attempts FROM offline_pin_lockout WHERE user_id = 'u1'", [], |r| r.get(0)).unwrap();
        assert_eq!(failed_attempts, 0);
    }

    #[test]
    fn locks_out_after_five_failed_attempts_and_denies_until_then() {
        let conn = test_conn();
        let salt = [2u8; 16];
        let derived = scrypt_derive("1234", &salt, 64).unwrap();
        let hash = format!("{}:{}", hex_encode(&salt), hex_encode(&derived));
        seed_staff(&conn, "u1", "active", Some(&hash));

        for _ in 0..4 {
            assert_eq!(verify_pin(&conn, "u1", "wrong").unwrap(), PinVerifyOutcome::Denied);
        }
        assert_eq!(verify_pin(&conn, "u1", "wrong").unwrap(), PinVerifyOutcome::Locked);
        // Locked even with the *correct* PIN now — same as the online path.
        assert_eq!(verify_pin(&conn, "u1", "1234").unwrap(), PinVerifyOutcome::Locked);
    }

    #[test]
    fn denies_a_user_with_no_pin_set_an_inactive_user_and_an_unknown_user() {
        let conn = test_conn();
        seed_staff(&conn, "no-pin", "active", None);
        seed_staff(&conn, "disabled", "disabled", Some("ff:ff"));

        assert_eq!(verify_pin(&conn, "no-pin", "1234").unwrap(), PinVerifyOutcome::Denied);
        assert_eq!(verify_pin(&conn, "disabled", "1234").unwrap(), PinVerifyOutcome::Denied);
        assert_eq!(verify_pin(&conn, "does-not-exist", "1234").unwrap(), PinVerifyOutcome::Denied);
    }
}
