use crate::db::DbState;
use crate::printer_settings;
use tauri::State;

fn with_connection<T>(
    db_state: &State<DbState>,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, printer_settings::PrinterSettingsError>,
) -> Result<T, String> {
    let guard = db_state.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or_else(|| "local database unavailable".to_string())?;
    f(conn).map_err(|e| e.to_string())
}

/// `json` is a serialized PrinterConnectionConfig — the setup screen builds
/// it from whichever transport (network/USB) the user picked.
#[tauri::command]
pub fn save_printer_config(db_state: State<DbState>, json: String) -> Result<(), String> {
    with_connection(&db_state, |conn| printer_settings::save(conn, &json))
}

#[tauri::command]
pub fn load_printer_config(db_state: State<DbState>) -> Result<Option<String>, String> {
    with_connection(&db_state, printer_settings::load)
}

#[tauri::command]
pub fn clear_printer_config(db_state: State<DbState>) -> Result<(), String> {
    with_connection(&db_state, printer_settings::clear)
}
