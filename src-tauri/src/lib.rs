pub mod commands;
pub mod render;
pub mod watch;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::initial_doc,
            commands::open_file,
            commands::mark_ready,
        ])
        .run(tauri::generate_context!())
        .expect("error while running mdread");
}
