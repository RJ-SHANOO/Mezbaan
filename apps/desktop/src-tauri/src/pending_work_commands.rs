use crate::db::DbState;
use crate::pending_work;
use tauri::State;

fn with_connection<T>(
    db_state: &State<DbState>,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, pending_work::PendingWorkError>,
) -> Result<T, String> {
    let guard = db_state.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or_else(|| "local database unavailable".to_string())?;
    f(conn).map_err(|e| e.to_string())
}

/// Called by the frontend whenever it wants its current in-progress state (an open
/// cart, in Phase 2) to survive a crash-and-relaunch — there's no fixed shape yet,
/// the frontend sends whatever JSON it wants back on `load_pending_work`.
#[tauri::command]
pub fn save_pending_work(db_state: State<DbState>, json: String) -> Result<(), String> {
    with_connection(&db_state, |conn| pending_work::save(conn, &json))
}

#[tauri::command]
pub fn load_pending_work(db_state: State<DbState>) -> Result<Option<String>, String> {
    with_connection(&db_state, pending_work::load)
}

/// Called once the frontend has successfully restored (or deliberately discarded)
/// pending work, so a stale blob doesn't keep reappearing on every future boot.
#[tauri::command]
pub fn clear_pending_work(db_state: State<DbState>) -> Result<(), String> {
    with_connection(&db_state, pending_work::clear)
}
