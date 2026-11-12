use crate::secure_store;
use rand::RngCore;
use rusqlite::Connection;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const DB_FILE_NAME: &str = "mezbaan.db";
const DB_ENCRYPTION_KEY_ACCOUNT: &str = "db-encryption-key";

/// Tauri-managed handle to the local database connection. `None` means startup
/// init failed — see rule 13: that must not crash the app, only leave local
/// storage unavailable until it's addressed.
pub struct DbState(pub Mutex<Option<Connection>>);

#[derive(Debug)]
pub enum DbError {
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
    SecureStore(secure_store::SecureStoreError),
    InvalidKey(String),
    IntegrityCheckFailed(String),
}

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DbError::Io(e) => write!(f, "local database I/O error: {e}"),
            DbError::Sqlite(e) => write!(f, "local database error: {e}"),
            DbError::SecureStore(e) => write!(f, "local database encryption key storage error: {e}"),
            DbError::InvalidKey(detail) => write!(f, "local database encryption key is invalid: {detail}"),
            DbError::IntegrityCheckFailed(detail) => {
                write!(f, "local database failed its startup integrity check: {detail}")
            }
        }
    }
}

impl std::error::Error for DbError {}

impl From<std::io::Error> for DbError {
    fn from(e: std::io::Error) -> Self {
        DbError::Io(e)
    }
}

impl From<rusqlite::Error> for DbError {
    fn from(e: rusqlite::Error) -> Self {
        DbError::Sqlite(e)
    }
}

impl From<secure_store::SecureStoreError> for DbError {
    fn from(e: secure_store::SecureStoreError) -> Self {
        DbError::SecureStore(e)
    }
}

struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration { version: 1, name: "init", sql: include_str!("../migrations/0001_init.sql") },
    Migration { version: 2, name: "operation_log", sql: include_str!("../migrations/0002_operation_log.sql") },
    Migration { version: 3, name: "manager_pin_offline", sql: include_str!("../migrations/0003_manager_pin_offline.sql") },
    Migration { version: 4, name: "document_number_sequence", sql: include_str!("../migrations/0004_document_number_sequence.sql") },
    Migration { version: 5, name: "menu_cache", sql: include_str!("../migrations/0005_menu_cache.sql") },
];

fn db_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(DB_FILE_NAME)
}

fn generate_hex_key() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The database encryption key's real home (P1-20): the OS-backed credential
/// store, via secure_store — not a plaintext file next to the database, which is
/// what this was before P1-20 gave it somewhere proper to live.
fn load_or_create_key(key_account: &str) -> Result<String, DbError> {
    if let Some(existing) = secure_store::load(key_account)? {
        return Ok(existing);
    }

    let hex_key = generate_hex_key();
    secure_store::store(key_account, &hex_key)?;
    Ok(hex_key)
}

fn validate_hex_key(hex_key: &str) -> Result<(), DbError> {
    if hex_key.len() == 64 && hex_key.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(DbError::InvalidKey(format!(
            "expected 64 hex characters, got {} characters",
            hex_key.len()
        )))
    }
}

fn open(path: &Path, hex_key: &str) -> Result<Connection, DbError> {
    validate_hex_key(hex_key)?;
    let conn = Connection::open(path)?;
    conn.execute_batch(&format!("PRAGMA key = \"x'{hex_key}'\";"))?;
    // SQLCipher only validates the key once something forces it to read a page.
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |row| row.get::<_, i64>(0))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(conn)
}

fn run_migrations(conn: &Connection) -> Result<(), DbError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );",
    )?;

    for migration in MIGRATIONS {
        let already_applied: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?1)",
            [migration.version],
            |row| row.get(0),
        )?;
        if already_applied {
            continue;
        }

        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(migration.sql)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name) VALUES (?1, ?2)",
            (migration.version, migration.name),
        )?;
        tx.commit()?;
    }
    Ok(())
}

fn integrity_check(conn: &Connection) -> Result<(), DbError> {
    let mut stmt = conn.prepare("PRAGMA integrity_check;")?;
    let mut rows = stmt.query([])?;
    let mut problems = Vec::new();
    while let Some(row) = rows.next()? {
        let line: String = row.get(0)?;
        if line != "ok" {
            problems.push(line);
        }
    }

    if problems.is_empty() {
        Ok(())
    } else {
        Err(DbError::IntegrityCheckFailed(problems.join("; ")))
    }
}

/// Opens (creating on first run) the encrypted, WAL-mode local database,
/// brings its schema up to date, and runs a startup integrity check.
pub fn init(app_data_dir: &Path) -> Result<Connection, DbError> {
    init_with_key_account(app_data_dir, DB_ENCRYPTION_KEY_ACCOUNT)
}

fn init_with_key_account(app_data_dir: &Path, key_account: &str) -> Result<Connection, DbError> {
    std::fs::create_dir_all(app_data_dir)?;
    let key = load_or_create_key(key_account)?;
    let conn = open(&db_path(app_data_dir), &key)?;
    run_migrations(&conn)?;
    integrity_check(&conn)?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("mezbaan-db-test-{label}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Every test below exercises SQLite/WAL/migration/integrity-check mechanics
    /// through `open()` with an explicit key — never through `init()`'s real
    /// secure_store-backed key lookup. That logic has nothing to do with whether an
    /// OS credential backend happens to be available on the machine running the
    /// test (see secure_store.rs's own tests for that), and it shouldn't start
    /// failing in a headless CI container just because this file now also has an
    /// `init()` that reads a key from the OS keychain.

    #[test]
    fn init_enables_wal_and_passes_integrity_check() {
        let dir = temp_dir("init-wal");
        let conn = open(&db_path(&dir), &generate_hex_key()).unwrap();
        run_migrations(&conn).unwrap();
        let mode: String = conn.query_row("PRAGMA journal_mode;", [], |r| r.get(0)).unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        integrity_check(&conn).unwrap();
    }

    #[test]
    fn migrations_apply_once_and_rerunning_is_a_no_op() {
        let dir = temp_dir("migrations");
        let conn = open(&db_path(&dir), &generate_hex_key()).unwrap();
        run_migrations(&conn).unwrap();
        let count_before: i64 = conn
            .query_row("SELECT count(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();

        run_migrations(&conn).unwrap();

        let count_after: i64 = conn
            .query_row("SELECT count(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count_before, count_after);

        conn.execute("INSERT INTO app_metadata (key, value) VALUES ('probe', '1')", [])
            .unwrap();
    }

    #[test]
    fn wrong_key_is_rejected_instead_of_silently_reading_garbage() {
        let dir = temp_dir("wrong-key");
        drop(open(&db_path(&dir), &generate_hex_key()).unwrap());

        let wrong_key = "0".repeat(64);
        let err = open(&db_path(&dir), &wrong_key).unwrap_err();
        match err {
            DbError::Sqlite(_) => {}
            other => panic!("expected a sqlite error for a wrong key, got {other:?}"),
        }
    }

    #[test]
    fn rejects_a_malformed_key_without_touching_sqlcipher() {
        let dir = temp_dir("malformed-key");
        let err = open(&db_path(&dir), "not-hex").unwrap_err();
        match err {
            DbError::InvalidKey(_) => {}
            other => panic!("expected InvalidKey, got {other:?}"),
        }
    }

    /// The one test that actually exercises `init()`'s secure_store-backed key
    /// lookup end to end. Tolerates a headless CI container with no OS credential
    /// backend (see secure_store.rs's `backend_unavailable`) the same way
    /// secure_store's own tests do — a fresh, nanos-suffixed account per call means
    /// this never collides with another test or with the real app's key.
    #[test]
    fn init_creates_and_reuses_a_key_via_secure_store() {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let key_account = format!("test-db-key-{nanos}");
        let dir = temp_dir("init-secure-store");

        let first = match init_with_key_account(&dir, &key_account) {
            Ok(conn) => conn,
            Err(DbError::SecureStore(_)) => return, // no OS credential backend here — see above
            Err(other) => panic!("unexpected error: {other}"),
        };
        integrity_check(&first).unwrap();
        drop(first);

        // Re-opening must reuse the same stored key, not generate a new one.
        let second = init_with_key_account(&dir, &key_account).unwrap();
        integrity_check(&second).unwrap();
    }
}
