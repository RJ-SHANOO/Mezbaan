//! P2-36: verifying a peer device's presented token against this branch's
//! roster — entirely offline, by hashing the raw token the same way the
//! server does (opaque-token.ts's `hashOpaqueToken`: plain SHA-256 hex, no
//! salt) and checking it against a locally cached list of
//! `{deviceId, tokenHash}` pairs. The roster itself (hub_roster.rs) is
//! fetched from the server once while online; this module never makes a
//! network call and never sees a raw stored token, only the hash.
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RosterEntry {
    pub device_id: String,
    pub token_hash: String,
}

pub fn hash_token(raw_token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw_token.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Returns the matching device's id, or `None` if no roster entry's hash
/// matches — a missing/empty token, a token belonging to no known paired
/// device, and a once-valid-but-now-revoked device (simply absent from a
/// freshly refreshed roster) all look the same: not authenticated.
pub fn authenticate(roster: &[RosterEntry], raw_token: &str) -> Option<String> {
    if raw_token.is_empty() {
        return None;
    }
    let presented_hash = hash_token(raw_token);
    roster.iter().find(|entry| entry.token_hash == presented_hash).map(|entry| entry.device_id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(device_id: &str, raw_token: &str) -> RosterEntry {
        RosterEntry { device_id: device_id.to_string(), token_hash: hash_token(raw_token) }
    }

    #[test]
    fn hash_token_is_deterministic_and_matches_a_known_sha256_vector() {
        // sha256("") — a fixed, well-known test vector, confirms this isn't
        // accidentally hashing with a salt or a different algorithm.
        assert_eq!(hash_token(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }

    #[test]
    fn authenticates_a_token_that_matches_a_roster_entry() {
        let roster = vec![entry("device-1", "secret-token-1"), entry("device-2", "secret-token-2")];
        assert_eq!(authenticate(&roster, "secret-token-2"), Some("device-2".to_string()));
    }

    #[test]
    fn rejects_a_token_with_no_matching_entry() {
        let roster = vec![entry("device-1", "secret-token-1")];
        assert_eq!(authenticate(&roster, "never-issued-token"), None);
    }

    #[test]
    fn rejects_an_empty_token_even_against_an_empty_roster() {
        assert_eq!(authenticate(&[], ""), None);
    }

    #[test]
    fn rejects_every_token_against_an_empty_roster() {
        assert_eq!(authenticate(&[], "some-token"), None);
    }

    #[test]
    fn a_revoked_devices_absence_from_a_refreshed_roster_is_rejected_like_any_unknown_token() {
        // Simulates hub_roster.rs's wholesale-replace-on-refresh: a device that
        // was valid under an older roster simply isn't in this one anymore.
        let roster_after_revocation = vec![entry("device-1", "secret-token-1")];
        assert_eq!(authenticate(&roster_after_revocation, "secret-token-2"), None);
    }
}
