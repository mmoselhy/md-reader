pub mod cli;
pub mod commands;
pub mod doc;
pub mod files;
pub mod paths;
pub mod render;
pub mod startup;
pub mod watch;

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::Manager;

use startup::{AppState, InitialSlot};

/// If the frontend never calls `mark_ready`, show the window anyway after this long.
const FALLBACK_SHOW: Duration = Duration::from_millis(1500);

pub fn run() {
    let start = Instant::now();

    // Read + render on a plain thread now, so it overlaps WebView2 startup.
    let args: Vec<String> = std::env::args_os().skip(1).map(|a| a.to_string_lossy().into_owned()).collect();
    let initial = Arc::new(InitialSlot::default());
    startup::spawn_initial_load(cli::parse_path_arg(&args), initial.clone());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new(start, initial))
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(FALLBACK_SHOW);
                if !handle.state::<AppState>().shown.swap(true, Ordering::SeqCst) {
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.show();
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::initial_doc,
            commands::open_file,
            commands::mark_ready,
        ])
        .run(tauri::generate_context!())
        .expect("error while running mdread");
}
