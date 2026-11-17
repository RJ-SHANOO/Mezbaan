use crate::db::DbState;
use crate::device_identity::{self, DeviceIdentity};
use crate::secure_store;
use tauri::State;

pub(crate) const DEVICE_TOKEN_ACCOUNT: &str = "device-token";

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
/// Clears the stored identity (P2-45) too — a terminal re-paired to a different
/// branch must never keep minting document numbers under the old one.
#[tauri::command]
pub fn clear_device_token(db_state: State<DbState>) -> Result<(), String> {
    secure_store::clear(DEVICE_TOKEN_ACCOUNT).map_err(|e| e.to_string())?;
    let guard = db_state.0.lock().map_err(|e| e.to_string())?;
    if let Some(conn) = guard.as_ref() {
        device_identity::clear(conn).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// P2-45: called by the pairing screen alongside store_device_token, with the
/// same `POST /devices/pair` response's branchNumber/terminalNumber — what an
/// offline sale needs to mint a P1-28 document number with no network call.
#[tauri::command]
pub fn save_device_identity(db_state: State<DbState>, branch_number: i64, terminal_number: i64) -> Result<(), String> {
    let guard = db_state.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or_else(|| "local database unavailable".to_string())?;
    device_identity::save(conn, DeviceIdentity { branch_number, terminal_number }).map_err(|e| e.to_string())
}
