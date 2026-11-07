use rusqlite::{Connection, OptionalExtension};
use std::fmt;

/// How many boots on a *different* version than the last confirmed-good one are
/// tolerated before deciding a rollback is warranted. Three gives a genuine crash
/// (vs. one bad launch from, say, a transient file-lock) a couple of retries
/// without leaving a terminal stuck on a broken update for long.
pub const MAX_BOOT_ATTEMPTS: u32 = 3;

const LAST_CONFIRMED_VERSION_KEY: &str = "last_confirmed_version";
const BOOT_ATTEMPTS_KEY: &str = "boot_attempts";

#[derive(Debug)]
pub struct UpdateHealthError(rusqlite::Error);

impl fmt::Display for UpdateHealthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "update health tracking error: {}", self.0)
    }
}

impl std::error::Error for UpdateHealthError {}

impl From<rusqlite::Error> for UpdateHealthError {
    fn from(e: rusqlite::Error) -> Self {
        UpdateHealthError(e)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootStatus {
    /// 0 when this boot is on the already-confirmed version (a normal restart,
    /// nothing to track); otherwise the count of consecutive unconfirmed boots on
    /// the current version, including this one.
    pub attempt: u32,
    pub should_roll_back: bool,
    /// Only set alongside `should_roll_back` — the last version this install
    /// actually confirmed as healthy, i.e. what a rollback should reinstall.
    pub rollback_target_version: Option<String>,
}

fn get_metadata(conn: &Connection, key: &str) -> Result<Option<String>, UpdateHealthError> {
    Ok(conn
        .query_row("SELECT value FROM app_metadata WHERE key = ?1", [key], |row| row.get(0))
        .optional()?)
}

fn set_metadata(conn: &Connection, key: &str, value: &str) -> Result<(), UpdateHealthError> {
    conn.execute(
        "INSERT INTO app_metadata (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )?;
    Ok(())
}

/// Called once at startup, right after the local database is ready (P1-19).
/// Compares the running version against the last one this install knows rendered
/// successfully: the same version is just a normal restart (nothing to track); a
/// different one (a just-applied update, or the very first launch ever) is a boot
/// attempt worth counting, and after MAX_BOOT_ATTEMPTS of those without ever
/// confirming success, this reports that a rollback is warranted.
///
/// This only *decides* — actually restarting the app with the rolled-back binary is
/// P1-22's watchdog's job, the same way P1-13 split a manager-PIN decision (online)
/// from enforcing it offline (P1-27b): the state machine here is complete and
/// tested on its own, independent of who acts on its answer.
pub fn record_boot_attempt(conn: &Connection, current_version: &str) -> Result<BootStatus, UpdateHealthError> {
    let last_confirmed_version = get_metadata(conn, LAST_CONFIRMED_VERSION_KEY)?;

    if last_confirmed_version.as_deref() == Some(current_version) {
        return Ok(BootStatus {
            attempt: 0,
            should_roll_back: false,
            rollback_target_version: None,
        });
    }

    let previous_attempts: u32 = get_metadata(conn, BOOT_ATTEMPTS_KEY)?
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let attempt = previous_attempts + 1;
    set_metadata(conn, BOOT_ATTEMPTS_KEY, &attempt.to_string())?;

    // No last_confirmed_version at all means this is the very first launch ever —
    // there's nothing known-good to roll back to, so a struggling first install
    // just keeps retrying rather than being reported as needing a "rollback."
    let should_roll_back = attempt > MAX_BOOT_ATTEMPTS && last_confirmed_version.is_some();
    Ok(BootStatus {
        attempt,
        should_roll_back,
        rollback_target_version: if should_roll_back { last_confirmed_version } else { None },
    })
}

/// Called by the frontend once the window has actually rendered (past the blank-
/// screen risk zone) — the signal that `current_version` is healthy enough to
/// become the rollback target if some future update goes bad.
pub fn confirm_boot_successful(conn: &Connection, current_version: &str) -> Result<(), UpdateHealthError> {
    set_metadata(conn, LAST_CONFIRMED_VERSION_KEY, current_version)?;
    set_metadata(conn, BOOT_ATTEMPTS_KEY, "0")?;
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
    fn first_ever_boot_is_attempt_one_and_never_rolls_back() {
        let conn = test_conn();
        let status = record_boot_attempt(&conn, "1.0.0").unwrap();
        assert_eq!(
            status,
            BootStatus { attempt: 1, should_roll_back: false, rollback_target_version: None }
        );
    }

    #[test]
    fn a_normal_restart_on_an_already_confirmed_version_is_not_tracked() {
        let conn = test_conn();
        confirm_boot_successful(&conn, "1.0.0").unwrap();
        let status = record_boot_attempt(&conn, "1.0.0").unwrap();
        assert_eq!(
            status,
            BootStatus { attempt: 0, should_roll_back: false, rollback_target_version: None }
        );
    }

    #[test]
    fn repeated_failed_boots_after_an_update_eventually_warrant_a_rollback() {
        let conn = test_conn();
        confirm_boot_successful(&conn, "1.0.0").unwrap();

        for expected_attempt in 1..=MAX_BOOT_ATTEMPTS {
            let status = record_boot_attempt(&conn, "2.0.0").unwrap();
            assert_eq!(status.attempt, expected_attempt);
            assert!(!status.should_roll_back, "shouldn't roll back yet at attempt {expected_attempt}");
        }

        let status = record_boot_attempt(&conn, "2.0.0").unwrap();
        assert!(status.should_roll_back);
        assert_eq!(status.rollback_target_version, Some("1.0.0".to_string()));
    }

    #[test]
    fn confirming_the_new_version_resets_attempts_and_moves_the_rollback_target() {
        let conn = test_conn();
        confirm_boot_successful(&conn, "1.0.0").unwrap();
        record_boot_attempt(&conn, "2.0.0").unwrap();
        confirm_boot_successful(&conn, "2.0.0").unwrap();

        let status = record_boot_attempt(&conn, "2.0.0").unwrap();
        assert_eq!(
            status,
            BootStatus { attempt: 0, should_roll_back: false, rollback_target_version: None }
        );
    }

    #[test]
    fn repeated_failures_on_the_very_first_install_never_trigger_a_rollback_with_nowhere_to_go() {
        let conn = test_conn();
        for _ in 0..(MAX_BOOT_ATTEMPTS + 5) {
            let status = record_boot_attempt(&conn, "1.0.0").unwrap();
            assert!(!status.should_roll_back);
        }
    }
}
