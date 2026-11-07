mod db;

use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Rule 13: a local database failure must not crash the app — POS and
            // kitchen windows still need to open. We just leave `DbState` empty
            // and log with context (rule 16) so there's a clear next step.
            let data_dir = app.path().app_data_dir()?;
            let db_state = match db::init(&data_dir) {
                Ok(conn) => db::DbState(Mutex::new(Some(conn))),
                Err(err) => {
                    log::error!("local database init failed, continuing without local storage: {err}");
                    db::DbState(Mutex::new(None))
                }
            };
            app.manage(db_state);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
