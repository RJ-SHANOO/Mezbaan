mod charges;
mod charges_commands;
mod db;
mod device_identity;
mod device_token;
mod document_number;
mod escpos;
mod hub_auth;
mod hub_commands;
mod hub_discovery;
mod hub_roster;
mod hub_server;
mod hub_state;
mod kitchen_ticket_commands;
mod kitchen_ticket_template;
mod manager_pin_offline;
mod menu_cache;
mod menu_commands;
mod offline_sale_commands;
mod offline_sales;
mod operation_log;
mod pending_work;
mod pending_work_commands;
mod print_queue;
mod printer_commands;
mod printer_discovery;
mod printer_settings;
mod printer_settings_commands;
mod printer_transport;
mod receipt_commands;
mod receipt_template;
mod secure_store;
mod snapshot_sync;
mod sync_client;
mod sync_status;
mod sync_status_commands;
mod update_commands;
mod update_health;

use std::path::Path;
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use update_commands::BootStatusState;
use update_health::BootStatus;

const CLEAN_SHUTDOWN_MARKER: &str = ".clean-shutdown";
/// A relaunch from the watchdog passes this so the new instance knows not to spawn
/// a second watchdog — the same one keeps watching across every relaunch.
const WATCHED_ARG: &str = "--watched";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![
            device_token::store_device_token,
            device_token::get_device_token,
            device_token::clear_device_token,
            device_token::save_device_identity,
            device_token::get_device_identity,
            update_commands::rollback_status,
            update_commands::confirm_boot_successful,
            pending_work_commands::save_pending_work,
            pending_work_commands::load_pending_work,
            pending_work_commands::clear_pending_work,
            sync_status_commands::get_sync_status,
            menu_commands::sync_menu,
            menu_commands::get_menu_categories,
            menu_commands::get_menu_products,
            menu_commands::find_menu_product_by_barcode,
            menu_commands::get_modifier_groups_for_product,
            menu_commands::get_menu_sync_version,
            menu_commands::get_tax_config,
            charges_commands::compute_offline_charges,
            offline_sale_commands::complete_offline_sale,
            printer_commands::print_raw_escpos,
            printer_commands::kick_cash_drawer,
            printer_commands::enqueue_print_job,
            printer_commands::enqueue_reprint_job,
            printer_commands::process_print_queue,
            printer_commands::get_print_queue_status,
            printer_commands::list_print_jobs,
            printer_commands::list_usb_printer_candidates,
            printer_commands::print_test_page,
            printer_settings_commands::save_printer_config,
            printer_settings_commands::load_printer_config,
            printer_settings_commands::clear_printer_config,
            receipt_commands::render_receipt,
            kitchen_ticket_commands::render_kitchen_ticket,
            hub_commands::start_hub,
            hub_commands::stop_hub,
            hub_commands::get_hub_status,
            hub_commands::refresh_hub_roster,
            hub_commands::discover_hubs,
            hub_commands::check_hub_reachable,
            hub_commands::publish_hub_update,
            mark_clean_shutdown,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Every terminal should relaunch at login (surviving a PC reboot, not
            // just an app crash) — best-effort, a failure here (e.g. restricted
            // permissions) shouldn't block the app from opening.
            if let Err(err) = app.autolaunch().enable() {
                log::error!("failed to enable launch-at-login: {err}");
            }

            let app_version = app.package_info().version.to_string();

            // Rule 13: a local database failure must not crash the app — POS and
            // kitchen windows still need to open. We just leave `DbState` empty
            // and log with context (rule 16) so there's a clear next step.
            let data_dir = app.path().app_data_dir()?;
            let no_rollback_info = || BootStatus { attempt: 0, should_roll_back: false, rollback_target_version: None };

            let (db_state, boot_status) = match db::init(&data_dir) {
                Ok(conn) => {
                    let boot_status = update_health::record_boot_attempt(&conn, &app_version).unwrap_or_else(|err| {
                        log::error!("update health tracking failed, continuing without it: {err}");
                        no_rollback_info()
                    });
                    if boot_status.should_roll_back {
                        log::error!(
                            "update health: {} consecutive unconfirmed boots on {app_version}, rollback target: {:?}",
                            boot_status.attempt,
                            boot_status.rollback_target_version,
                        );
                    }
                    (db::DbState(Mutex::new(Some(conn))), boot_status)
                }
                Err(err) => {
                    log::error!("local database init failed, continuing without local storage: {err}");
                    (db::DbState(Mutex::new(None)), no_rollback_info())
                }
            };
            app.manage(db_state);
            app.manage(BootStatusState(Mutex::new(boot_status)));
            // P2-36: hub mode starts OFF on every launch — it's an explicit,
            // per-session choice (start_hub), never something that silently
            // turns itself on just because this terminal was once a hub.
            app.manage(hub_commands::HubState(Mutex::new(None)));

            // Only the very first, normally-launched instance spawns a watchdog — a
            // relaunch the watchdog itself triggered carries WATCHED_ARG, since the
            // same watchdog process keeps watching across every relaunch rather than
            // spawning a new one each time.
            if !std::env::args().any(|arg| arg == WATCHED_ARG) {
                spawn_watchdog(&data_dir.join(CLEAN_SHUTDOWN_MARKER));
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // A deliberate exit (not a crash) — tell the watchdog this one's on purpose
        // so it cleans up and stops watching instead of relaunching.
        if let tauri::RunEvent::Exit = event {
            write_clean_shutdown_marker(app_handle);
        }
    });
}

fn write_clean_shutdown_marker(app_handle: &tauri::AppHandle) {
    if let Ok(data_dir) = app_handle.path().app_data_dir() {
        if let Err(err) = std::fs::write(data_dir.join(CLEAN_SHUTDOWN_MARKER), "") {
            log::error!("failed to write clean-shutdown marker: {err}");
        }
    }
}

/// The updater's own install step replaces this process (and, on Windows, exits
/// it) outside of RunEvent::Exit — without this, the watchdog would see the PID
/// disappear with no marker and race the updater by also trying to relaunch the
/// (stale, about-to-be-replaced) old binary. UpdateChecker.tsx calls this right
/// before `update.downloadAndInstall()` so that race can't happen.
#[tauri::command]
fn mark_clean_shutdown(app: tauri::AppHandle) {
    write_clean_shutdown_marker(&app);
}

fn spawn_watchdog(marker_path: &Path) {
    let Ok(exe_path) = std::env::current_exe() else {
        log::error!("failed to resolve this executable's own path, watchdog not started");
        return;
    };
    let watchdog_file_name = if cfg!(windows) { "mezbaan-watchdog.exe" } else { "mezbaan-watchdog" };
    let watchdog_path = exe_path.with_file_name(watchdog_file_name);

    let result = std::process::Command::new(&watchdog_path)
        .arg(exe_path.to_string_lossy().into_owned())
        .arg(std::process::id().to_string())
        .arg(marker_path.to_string_lossy().into_owned())
        .spawn();

    if let Err(err) = result {
        log::error!("failed to spawn watchdog ({}), crash recovery unavailable this run: {err}", watchdog_path.display());
    }
}
