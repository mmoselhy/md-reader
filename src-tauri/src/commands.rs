// SCAFFOLD STUB: Task A replaces these bodies. Signatures follow SPEC.md "IPC contract".
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Doc {
    pub path: String,
    pub title: String,
    pub html: String,
    pub render_ms: f64,
}

#[tauri::command]
pub async fn initial_doc() -> Result<Option<Doc>, String> {
    Ok(None)
}

#[tauri::command]
pub async fn open_file(path: String) -> Result<Doc, String> {
    Err(format!("open_file not implemented yet: {path}"))
}

#[tauri::command]
pub fn mark_ready(window: tauri::WebviewWindow) {
    let _ = window.show();
}
