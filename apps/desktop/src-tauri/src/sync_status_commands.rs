use crate::db::DbState;
use crate::sync_status::{self, SyncStatus};
use tauri::State;

/// Polled by the POS/kitchen frontend to drive the sync status indicator (P1-29):
/// pending count, whether the last attempt reached the server, and when the last
/// one actually succeeded.
#[tauri::command]
pub fn get_sync_status(db_state: State<DbState>) -> Result<SyncStatus, String> {
    let guard = db_state.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or_else(|| "local database unavailable".to_string())?;
    sync_status::get_status(conn).map_err(|e| e.to_string())
}
