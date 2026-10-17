//! Thin Tauri adapters over `doc`, `watch` and `startup` (SPEC section 4).

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State, WebviewWindow};

pub use crate::doc::Doc;
use crate::doc::load_doc;
use crate::startup::{log_timing, AppState};
use crate::watch::{FileWatcher, WatchEvent};

#[derive(Serialize, Clone)]
struct PathPayload {
    path: String,
}

/// Replaces the active watcher with one for `path` (an already absolute `Doc.path`).
fn watch_file(app: &AppHandle, state: &AppState, path: &str) {
    let handle = app.clone();
    let watcher = FileWatcher::start(Path::new(path), move |event| {
        let (name, path) = match event {
            WatchEvent::Changed(p) => ("file-changed", p),
            WatchEvent::Removed(p) => ("file-removed", p),
        };
        let _ = handle.emit(name, PathPayload { path });
    });
    let watcher = match watcher {
        Ok(w) => Some(w),
        Err(e) => {
            eprintln!("mdread: {e}");
            None
        }
    };
    *state.watcher.lock().unwrap_or_else(|e| e.into_inner()) = watcher;
}

#[tauri::command]
pub async fn initial_doc(app: AppHandle, state: State<'_, AppState>) -> Result<Option<Doc>, String> {
    let slot = state.initial.clone();
    // Wait off the async worker so a slow render can't stall other commands.
    let result = tauri::async_runtime::spawn_blocking(move || slot.wait())
        .await
        .map_err(|e| e.to_string())?;
    if let Ok(Some(doc)) = &result {
        if !state.watch_claimed.swap(true, Ordering::SeqCst) {
            watch_file(&app, &state, &doc.path);
        }
    }
    result
}

#[tauri::command]
pub async fn open_file(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<Doc, String> {
    let doc = tauri::async_runtime::spawn_blocking(move || load_doc(&PathBuf::from(path)))
        .await
        .map_err(|e| e.to_string())??;
    state.watch_claimed.store(true, Ordering::SeqCst);
    watch_file(&app, &state, &doc.path);
    Ok(doc)
}

#[tauri::command]
pub fn mark_ready(window: WebviewWindow, state: State<'_, AppState>) {
    state.shown.store(true, Ordering::SeqCst);
    let _ = window.show();
    let _ = window.set_focus();
    if !state.ready_logged.swap(true, Ordering::SeqCst) {
        log_timing("ready_ms", state.start.elapsed().as_secs_f64() * 1000.0);
    }
}
