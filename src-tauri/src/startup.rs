//! Process-start state: the background initial render, the timing log and the managed app state.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

use crate::doc::{load_doc, Doc};
use crate::watch::FileWatcher;

pub type InitialResult = Result<Option<Doc>, String>;

/// Write-once result of the initial render; `wait` can be called any number of times.
#[derive(Default)]
pub struct InitialSlot {
    result: Mutex<Option<InitialResult>>,
    ready: Condvar,
}

impl InitialSlot {
    pub fn fulfill(&self, result: InitialResult) {
        *self.result.lock().unwrap_or_else(|e| e.into_inner()) = Some(result);
        self.ready.notify_all();
    }

    /// Blocks until fulfilled, then returns a clone of the result.
    pub fn wait(&self) -> InitialResult {
        let guard = self.result.lock().unwrap_or_else(|e| e.into_inner());
        let guard = self.ready.wait_while(guard, |r| r.is_none()).unwrap_or_else(|e| e.into_inner());
        guard.clone().expect("fulfilled")
    }
}

/// Starts reading and rendering `path` on a background thread. Call before building the webview.
pub fn spawn_initial_load(path: Option<PathBuf>, slot: Arc<InitialSlot>) {
    std::thread::spawn(move || {
        let result = match path {
            None => Ok(None),
            Some(p) => {
                let started = Instant::now();
                let doc = load_doc(&p);
                if doc.is_ok() {
                    log_timing("initial_render_ms", started.elapsed().as_secs_f64() * 1000.0);
                }
                doc.map(Some)
            }
        };
        slot.fulfill(result);
    });
}

/// Appends `<key>=<value>` to the file named by `MDREAD_TIMING`, if set. Failures are ignored.
pub fn log_timing(key: &str, value: f64) {
    use std::io::Write;
    let Some(target) = std::env::var_os("MDREAD_TIMING") else { return };
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(target) {
        let _ = writeln!(f, "{key}={value}");
    }
}

/// Managed Tauri state.
pub struct AppState {
    pub start: Instant,
    pub initial: Arc<InitialSlot>,
    /// The single active watcher; replaced (old one dropped) by `open_file`.
    pub watcher: Mutex<Option<FileWatcher>>,
    /// Set once `initial_doc` (or `open_file`) has taken over watching, so repeat calls don't re-watch.
    pub watch_claimed: AtomicBool,
    /// Set by the first `mark_ready` or by the fallback timer; whichever comes first shows the window.
    pub shown: AtomicBool,
    pub ready_logged: AtomicBool,
}

impl AppState {
    pub fn new(start: Instant, initial: Arc<InitialSlot>) -> Self {
        Self {
            start,
            initial,
            watcher: Mutex::new(None),
            watch_claimed: AtomicBool::new(false),
            shown: AtomicBool::new(false),
            ready_logged: AtomicBool::new(false),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_path_gives_none_and_repeats() {
        let slot = Arc::new(InitialSlot::default());
        spawn_initial_load(None, slot.clone());
        assert!(matches!(slot.wait(), Ok(None)));
        assert!(matches!(slot.wait(), Ok(None)));
    }

    #[test]
    fn error_is_cached_for_repeat_calls() {
        let slot = Arc::new(InitialSlot::default());
        spawn_initial_load(Some(PathBuf::from(r"Z:\missing\x.md")), slot.clone());
        let a = slot.wait().unwrap_err();
        assert_eq!(a, slot.wait().unwrap_err());
        assert!(a.starts_with("File not found: "));
    }

    #[test]
    fn success_is_cached_and_timing_logged() {
        let dir = std::env::temp_dir().join(format!("mdread-startup-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.md");
        std::fs::write(&file, "# Hi").unwrap();
        let log = dir.join("timing.log");
        let _ = std::fs::remove_file(&log);
        std::env::set_var("MDREAD_TIMING", &log);

        let slot = Arc::new(InitialSlot::default());
        spawn_initial_load(Some(file), slot.clone());
        let first = slot.wait().unwrap().unwrap();
        let second = slot.wait().unwrap().unwrap();
        assert_eq!(first.html, second.html);
        assert!(first.html.contains("<h1"));

        let text = std::fs::read_to_string(&log).unwrap();
        assert!(text.starts_with("initial_render_ms="), "{text}");
        assert!(text.trim_end().split('=').nth(1).unwrap().parse::<f64>().is_ok());
        std::env::remove_var("MDREAD_TIMING");
    }
}
