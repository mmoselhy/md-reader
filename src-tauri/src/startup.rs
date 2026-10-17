//! Process-start state: the background initial render, the timing log and the managed app state.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Instant;

use crate::doc::{load_doc, Doc, Loaded};
use crate::watch::FileWatcher;

/// The initial render, rest not yet published (its id is assigned by `RestStore`, which doesn't exist yet).
pub type InitialResult = Result<Option<Loaded>, String>;

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

/// The rest of the most recent split document, keyed by the id handed out in `Doc.rest_id`.
#[derive(Default)]
pub struct RestStore {
    next_id: AtomicU64,
    current: Mutex<Option<(u64, Arc<String>)>>,
}

impl RestStore {
    /// Makes `loaded` the stored document: a split one gets a fresh id (set on the returned `Doc`),
    /// an unsplit one clears the store.
    pub fn publish(&self, loaded: Loaded) -> Doc {
        let Loaded { mut doc, rest } = loaded;
        let entry = rest.map(|r| (self.next_id.fetch_add(1, Ordering::SeqCst) + 1, r));
        doc.rest_id = entry.as_ref().map(|(id, _)| *id);
        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = entry;
        doc
    }

    /// The rest for `id`, or `Stale document part` if `id` isn't the stored one. Non-destructive.
    pub fn get(&self, id: u64) -> Result<Arc<String>, String> {
        match &*self.current.lock().unwrap_or_else(|e| e.into_inner()) {
            Some((stored, rest)) if *stored == id => Ok(rest.clone()),
            _ => Err("Stale document part".to_string()),
        }
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
    /// `initial` after its rest was published; set once so repeat `initial_doc` calls return the same `restId`.
    pub initial_published: OnceLock<Result<Option<Doc>, String>>,
    pub rest: RestStore,
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
            initial_published: OnceLock::new(),
            rest: RestStore::default(),
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
        let first = slot.wait().unwrap().unwrap().doc;
        let second = slot.wait().unwrap().unwrap().doc;
        assert_eq!(first.html, second.html);
        assert!(first.html.contains("<h1"));

        let text = std::fs::read_to_string(&log).unwrap();
        assert!(text.starts_with("initial_render_ms="), "{text}");
        assert!(text.trim_end().split('=').nth(1).unwrap().parse::<f64>().is_ok());
        std::env::remove_var("MDREAD_TIMING");
    }

    fn loaded(rest: Option<&str>) -> Loaded {
        let doc = Doc { path: r"C:\a.md".into(), title: "a.md".into(), html: "head".into(), rest_id: None, render_ms: 0.0 };
        Loaded { doc, rest: rest.map(|r| Arc::new(r.to_string())) }
    }

    #[test]
    fn rest_store_replaces_clears_and_rejects_stale() {
        let store = RestStore::default();
        let a = store.publish(loaded(Some("rest-a"))).rest_id.unwrap();
        assert_eq!(*store.get(a).unwrap(), "rest-a");
        assert_eq!(*store.get(a).unwrap(), "rest-a", "non-destructive");

        let b = store.publish(loaded(Some("rest-b"))).rest_id.unwrap();
        assert_ne!(a, b);
        assert_eq!(store.get(a).unwrap_err(), "Stale document part");
        assert_eq!(*store.get(b).unwrap(), "rest-b");

        let unsplit = store.publish(loaded(None));
        assert_eq!(unsplit.rest_id, None);
        assert_eq!(store.get(b).unwrap_err(), "Stale document part");
        assert_eq!(store.get(0).unwrap_err(), "Stale document part");
    }

    #[test]
    fn initial_split_keeps_one_rest_id_and_rest_stays_retrievable() {
        let dir = std::env::temp_dir().join(format!("mdread-startup-split-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("big.md");
        std::fs::write(&file, "paragraph text

".repeat(5000)).unwrap();

        let slot = Arc::new(InitialSlot::default());
        spawn_initial_load(Some(file), slot.clone());
        let state = AppState::new(Instant::now(), slot);
        // What `initial_doc` does, twice.
        let call = || {
            state
                .initial_published
                .get_or_init(|| state.initial.wait().map(|o| o.map(|l| state.rest.publish(l))))
                .clone()
                .unwrap()
                .unwrap()
        };
        let (first, second) = (call(), call());
        let id = first.rest_id.expect("split");
        assert_eq!(Some(id), second.rest_id);
        assert_eq!(first.html, second.html);
        let rest = state.rest.get(id).unwrap();
        assert_eq!(state.rest.get(id).unwrap(), rest);
        assert!(rest.starts_with("<p>"));
    }
}
