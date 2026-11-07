use crate::secure_store;

const DEVICE_TOKEN_ACCOUNT: &str = "device-token";

/// Invoked by the pairing screen right after `POST /devices/pair` succeeds, to put
/// the raw device token (api-pos only ever returns it once) into the OS credential
/// store rather than anywhere in app state or on disk unencrypted.
#[tauri::command]
pub fn store_device_token(token: String) -> Result<(), String> {
    secure_store::store(DEVICE_TOKEN_ACCOUNT, &token).map_err(|e| e.to_string())
}

/// `None` means this terminal has never been paired (or was unpaired) — the
/// frontend's startup check for whether to show the pairing screen.
#[tauri::command]
pub fn get_device_token() -> Result<Option<String>, String> {
    secure_store::load(DEVICE_TOKEN_ACCOUNT).map_err(|e| e.to_string())
}

/// Used when a terminal needs to be unpaired locally (e.g. before re-pairing after
/// a remote revocation) — doesn't call the server; that's the admin-side revoke.
#[tauri::command]
pub fn clear_device_token() -> Result<(), String> {
    secure_store::clear(DEVICE_TOKEN_ACCOUNT).map_err(|e| e.to_string())
}
