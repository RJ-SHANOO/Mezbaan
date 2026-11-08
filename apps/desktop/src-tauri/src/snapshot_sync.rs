//! Fetches P1-27's signed snapshot over HTTP and verifies its Ed25519 signature
//! before anything downstream (manager_pin_offline, and whatever Phase 2 adds for
//! menu/prices) is allowed to trust its contents.
//!
//! The public key is a parameter here, not fetched live — it must come from the
//! app's own build/deploy-time config (CLAUDE.md rule 3: a terminal only trusts
//! signed, versioned data), the same way a self-update's signing key is embedded in
//! tauri.conf.json rather than requested from the same server being verified.
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::pkcs8::DecodePublicKey;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use std::fmt;
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub enum SnapshotSyncError {
    Transport(String),
    InvalidPublicKey(String),
    InvalidSignature,
}

impl fmt::Display for SnapshotSyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SnapshotSyncError::Transport(detail) => write!(f, "snapshot sync: transport error: {detail}"),
            SnapshotSyncError::InvalidPublicKey(detail) => write!(f, "snapshot sync: invalid public key: {detail}"),
            SnapshotSyncError::InvalidSignature => write!(f, "snapshot sync: signature verification failed"),
        }
    }
}

impl std::error::Error for SnapshotSyncError {}

#[derive(Debug, Deserialize)]
struct SnapshotResponse {
    version: String,
    #[serde(rename = "contentJson")]
    content_json: String,
    signature: String,
}

pub struct VerifiedSnapshot {
    pub version: String,
    /// Still the raw JSON string, deliberately unparsed here — hand it to whichever
    /// module actually consumes a section of it (manager_pin_offline for staff,
    /// future modules for menu/prices), the same "don't re-serialize signed bytes"
    /// reasoning as sync_client.rs.
    pub content_json: String,
}

/// `public_key_pem` is an Ed25519 SPKI PEM — the same format
/// snapshot-signing.ts's getSnapshotPublicKeyPem() / GET /sync/public-key return.
pub fn fetch_and_verify_snapshot(sync_url: &str, device_token: &str, public_key_pem: &str) -> Result<VerifiedSnapshot, SnapshotSyncError> {
    let verifying_key =
        VerifyingKey::from_public_key_pem(public_key_pem).map_err(|e| SnapshotSyncError::InvalidPublicKey(e.to_string()))?;

    let client = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| SnapshotSyncError::Transport(e.to_string()))?;
    let response = client
        .get(sync_url)
        .header("x-device-token", device_token)
        .send()
        .map_err(|e| SnapshotSyncError::Transport(e.to_string()))?;
    if !response.status().is_success() {
        return Err(SnapshotSyncError::Transport(format!("snapshot endpoint returned {}", response.status())));
    }
    let body: SnapshotResponse = response.json().map_err(|e| SnapshotSyncError::Transport(e.to_string()))?;

    verify_snapshot_signature(&verifying_key, &body.content_json, &body.signature)?;
    Ok(VerifiedSnapshot { version: body.version, content_json: body.content_json })
}

fn verify_snapshot_signature(verifying_key: &VerifyingKey, content_json: &str, signature_base64: &str) -> Result<(), SnapshotSyncError> {
    let signature_bytes = STANDARD.decode(signature_base64).map_err(|_| SnapshotSyncError::InvalidSignature)?;
    let signature_array: [u8; 64] = signature_bytes.as_slice().try_into().map_err(|_| SnapshotSyncError::InvalidSignature)?;
    let signature = Signature::from_bytes(&signature_array);
    verifying_key
        .verify(content_json.as_bytes(), &signature)
        .map_err(|_| SnapshotSyncError::InvalidSignature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::pkcs8::EncodePublicKey;
    use ed25519_dalek::{Signer, SigningKey};

    fn test_keypair() -> (SigningKey, String) {
        let signing_key = SigningKey::generate(&mut rand::rngs::OsRng);
        let pem = signing_key.verifying_key().to_public_key_pem(Default::default()).unwrap();
        (signing_key, pem)
    }

    #[test]
    fn verifies_a_correctly_signed_payload() {
        let (signing_key, public_key_pem) = test_keypair();
        let content = r#"{"staff":[]}"#;
        let signature = signing_key.sign(content.as_bytes());
        let verifying_key = VerifyingKey::from_public_key_pem(&public_key_pem).unwrap();

        assert!(verify_snapshot_signature(&verifying_key, content, &STANDARD.encode(signature.to_bytes())).is_ok());
    }

    #[test]
    fn rejects_a_payload_that_was_tampered_with_after_signing() {
        let (signing_key, public_key_pem) = test_keypair();
        let signature = signing_key.sign(r#"{"staff":[]}"#.as_bytes());
        let verifying_key = VerifyingKey::from_public_key_pem(&public_key_pem).unwrap();

        let result = verify_snapshot_signature(&verifying_key, r#"{"staff":[{"id":"injected"}]}"#, &STANDARD.encode(signature.to_bytes()));
        assert!(matches!(result, Err(SnapshotSyncError::InvalidSignature)));
    }

    #[test]
    fn rejects_a_signature_from_the_wrong_key() {
        let (_, public_key_pem) = test_keypair();
        let (other_signing_key, _) = test_keypair();
        let content = r#"{"staff":[]}"#;
        let wrong_signature = other_signing_key.sign(content.as_bytes());
        let verifying_key = VerifyingKey::from_public_key_pem(&public_key_pem).unwrap();

        let result = verify_snapshot_signature(&verifying_key, content, &STANDARD.encode(wrong_signature.to_bytes()));
        assert!(matches!(result, Err(SnapshotSyncError::InvalidSignature)));
    }

    #[test]
    fn rejects_garbage_base64_or_wrong_length_signatures() {
        let (_, public_key_pem) = test_keypair();
        let verifying_key = VerifyingKey::from_public_key_pem(&public_key_pem).unwrap();

        assert!(matches!(verify_snapshot_signature(&verifying_key, "{}", "not-base64!!!"), Err(SnapshotSyncError::InvalidSignature)));
        assert!(matches!(verify_snapshot_signature(&verifying_key, "{}", &STANDARD.encode(b"too short")), Err(SnapshotSyncError::InvalidSignature)));
    }
}
