//! P2-11: the frontend's entry points for the menu cache — fetching a fresh
//! snapshot and reading what's already cached locally. `api_base_url` and
//! `public_key_pem` are passed in from the frontend's own build-time config
//! (Vite env vars, same as api-client.ts's existing VITE_API_POS_URL) rather
//! than hardcoded here — but critically, build-time config, never fetched
//! live from the same server being verified (see snapshot_sync.rs).
use crate::db::DbState;
use crate::device_token::DEVICE_TOKEN_ACCOUNT;
use crate::manager_pin_offline;
use crate::menu_cache::{self, MenuCategory, MenuProduct, ModifierGroupWithOptions};
use crate::secure_store;
use crate::snapshot_sync;
use crate::sync_status;
use tauri::State;

#[tauri::command]
pub fn sync_menu(db_state: State<DbState>, api_base_url: String, public_key_pem: String) -> Result<String, String> {
    let device_token = secure_store::load(DEVICE_TOKEN_ACCOUNT)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "this terminal is not paired yet".to_string())?;

    let sync_url = format!("{}/sync/snapshot", api_base_url.trim_end_matches('/'));
    let snapshot = snapshot_sync::fetch_and_verify_snapshot(&sync_url, &device_token, &public_key_pem).map_err(|e| e.to_string())?;

    let mut guard = db_state.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_mut().ok_or_else(|| "local database unavailable".to_string())?;

    manager_pin_offline::ingest_snapshot(conn, &snapshot.version, &snapshot.content_json).map_err(|e| e.to_string())?;
    menu_cache::ingest_snapshot(conn, &snapshot.content_json).map_err(|e| e.to_string())?;
    // P2-17: persisted so get_menu_sync_version reflects it immediately on every
    // later read, including after this terminal restarts.
    sync_status::record_menu_sync_version(conn, &snapshot.version).map_err(|e| e.to_string())?;

    Ok(snapshot.version)
}

/// P2-17: the "prices as of" timestamp from the last successfully ingested
/// snapshot, read straight from local storage — unlike sync_menu, this makes no
/// network call, so the POS screen can show it immediately on mount, before (or
/// even if) this session's own sync_menu call ever resolves.
#[tauri::command]
pub fn get_menu_sync_version(db_state: State<DbState>) -> Result<Option<String>, String> {
    let guard = db_state.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or_else(|| "local database unavailable".to_string())?;
    sync_status::get_menu_sync_version(conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_menu_categories(db_state: State<DbState>) -> Result<Vec<MenuCategory>, String> {
    let guard = db_state.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or_else(|| "local database unavailable".to_string())?;
    menu_cache::list_categories(conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_menu_products(db_state: State<DbState>, category_id: Option<String>, search: Option<String>) -> Result<Vec<MenuProduct>, String> {
    let guard = db_state.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or_else(|| "local database unavailable".to_string())?;
    menu_cache::list_products(conn, category_id.as_deref(), search.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn find_menu_product_by_barcode(db_state: State<DbState>, barcode: String) -> Result<Option<MenuProduct>, String> {
    let guard = db_state.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or_else(|| "local database unavailable".to_string())?;
    menu_cache::find_by_barcode(conn, &barcode).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_modifier_groups_for_product(db_state: State<DbState>, product_id: String) -> Result<Vec<ModifierGroupWithOptions>, String> {
    let guard = db_state.0.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or_else(|| "local database unavailable".to_string())?;
    menu_cache::list_modifier_groups_for_product(conn, &product_id).map_err(|e| e.to_string())
}
