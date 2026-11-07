use crate::db::DbState;
use crate::update_health::{self, BootStatus};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// Tauri-managed handle to this boot's health decision, computed once at startup
/// (see lib.rs's setup hook) and read by the frontend's update-checker to decide
/// whether to ask api-pos for a rollback manifest instead of the normal latest one.
pub struct BootStatusState(pub Mutex<BootStatus>);

#[tauri::command]
pub fn rollback_status(state: State<BootStatusState>) -> Result<BootStatus, String> {
    state.0.lock().map(|status| status.clone()).map_err(|e| e.to_string())
}

/// Called by the frontend once a window has actually rendered — past the blank-
/// screen risk zone that would otherwise count as a failed boot.
#[tauri::command]
pub fn confirm_boot_successful(app: AppHandle, db_state: State<DbState>, boot_status_state: State<BootStatusState>) -> Result<(), String> {
    let version = app.package_info().version.to_string();

    let conn_guard = db_state.0.lock().map_err(|e| e.to_string())?;
    let conn = conn_guard.as_ref().ok_or_else(|| "local database unavailable".to_string())?;
    update_health::confirm_boot_successful(conn, &version).map_err(|e| e.to_string())?;
    drop(conn_guard);

    let mut status_guard = boot_status_state.0.lock().map_err(|e| e.to_string())?;
    *status_guard = BootStatus { attempt: 0, should_roll_back: false, rollback_target_version: None };
    Ok(())
}
