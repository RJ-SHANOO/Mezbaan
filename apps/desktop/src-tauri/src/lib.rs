mod db;
mod device_token;
mod secure_store;
mod update_commands;
mod update_health;

use std::sync::Mutex;
use tauri::Manager;
use update_commands::BootStatusState;
use update_health::BootStatus;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            device_token::store_device_token,
            device_token::get_device_token,
            device_token::clear_device_token,
            update_commands::rollback_status,
            update_commands::confirm_boot_successful,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
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

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
