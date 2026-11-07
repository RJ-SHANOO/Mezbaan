use keyring::Entry;
use std::fmt;

const SERVICE_NAME: &str = "com.mezbaan.desktop";

#[derive(Debug)]
pub struct SecureStoreError(keyring::Error);

impl fmt::Display for SecureStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "secure storage error: {}", self.0)
    }
}

impl std::error::Error for SecureStoreError {}

impl From<keyring::Error> for SecureStoreError {
    fn from(e: keyring::Error) -> Self {
        SecureStoreError(e)
    }
}

/// Thin wrapper over the OS-backed credential store (Windows Credential Manager /
/// macOS Keychain / Linux Secret Service, via the `keyring` crate) — the real home
/// for secrets that P1-19 originally stopgapped as a plaintext file next to the
/// database. One entry per `account` under a single app-wide service name; a given
/// account is global to this machine+user, same as the OS credential store itself
/// (there's one terminal install per machine, so that's the right scope).
pub fn store(account: &str, secret: &str) -> Result<(), SecureStoreError> {
    Entry::new(SERVICE_NAME, account)?.set_password(secret)?;
    Ok(())
}

pub fn load(account: &str) -> Result<Option<String>, SecureStoreError> {
    match Entry::new(SERVICE_NAME, account)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn clear(account: &str) -> Result<(), SecureStoreError> {
    match Entry::new(SERVICE_NAME, account)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A fresh account per test, so parallel test threads never collide and nothing
    /// durable gets left behind in the real OS credential store beyond this run.
    fn test_account(label: &str) -> String {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        format!("test-{label}-{nanos}")
    }

    /// CI's Linux runner has no running Secret Service daemon (no desktop session),
    /// so keyring can't initialize a backend there — that's an environment gap, not
    /// a bug in this code. Real coverage happens wherever a backend IS available
    /// (every actual POS terminal, and most dev machines, Windows included).
    fn backend_unavailable(err: &SecureStoreError) -> bool {
        matches!(err.0, keyring::Error::NoDefaultStore | keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_))
    }

    #[test]
    fn round_trips_a_secret_and_cleans_up() {
        let account = test_account("round-trip");

        if let Err(e) = store(&account, "super-secret-token") {
            assert!(backend_unavailable(&e), "unexpected error: {e}");
            return;
        }

        assert_eq!(load(&account).unwrap(), Some("super-secret-token".to_string()));
        clear(&account).unwrap();
        assert_eq!(load(&account).unwrap(), None);
    }

    #[test]
    fn load_on_a_missing_account_is_none_not_an_error() {
        let account = test_account("missing");
        match load(&account) {
            Ok(value) => assert_eq!(value, None),
            Err(e) => assert!(backend_unavailable(&e), "unexpected error: {e}"),
        }
    }

    #[test]
    fn clearing_an_already_missing_account_is_a_no_op() {
        let account = test_account("double-clear");
        match clear(&account) {
            Ok(()) => {}
            Err(e) => assert!(backend_unavailable(&e), "unexpected error: {e}"),
        }
    }
}
