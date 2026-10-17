//! File watching (SPEC section 6). Tauri-free: callers pass a callback.
//!
//! The file's parent directory is watched (non-recursive) because editors save atomically
//! (write temp -> rename), which would break a watch on the file itself.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};

use crate::paths::display_path;

pub const DEBOUNCE: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchEvent {
    /// Modified, replaced or recreated. Carries the watched path (same format as `Doc.path`).
    Changed(String),
    /// Deleted or renamed away and not back after the debounce window.
    Removed(String),
}

/// Watches one file; dropping it stops the watch.
pub struct FileWatcher {
    _debouncer: Debouncer<RecommendedWatcher>,
}

impl FileWatcher {
    /// `path` must be absolute. `on_event` runs on the debouncer's thread.
    pub fn start(path: &Path, on_event: impl Fn(WatchEvent) + Send + 'static) -> Result<Self, String> {
        let dir = path.parent().ok_or_else(|| format!("No parent directory: {}", display_path(path)))?;
        let name = path
            .file_name()
            .ok_or_else(|| format!("No file name: {}", display_path(path)))?
            .to_os_string();
        let watched: PathBuf = path.to_path_buf();
        let shown = display_path(path);

        let mut debouncer = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            if !events.iter().any(|e| same_name(e.path.file_name(), &name)) {
                return;
            }
            // The file system decides: a rename-over-target burst ends with the file present.
            on_event(if watched.exists() {
                WatchEvent::Changed(shown.clone())
            } else {
                WatchEvent::Removed(shown.clone())
            });
        })
        .map_err(|e| format!("Could not watch {}: {e}", display_path(dir)))?;

        debouncer
            .watcher()
            .watch(dir, RecursiveMode::NonRecursive)
            .map_err(|e| format!("Could not watch {}: {e}", display_path(dir)))?;
        Ok(Self { _debouncer: debouncer })
    }
}

fn same_name(candidate: Option<&std::ffi::OsStr>, target: &OsString) -> bool {
    match candidate {
        Some(c) if cfg!(windows) => c.to_string_lossy().to_lowercase() == target.to_string_lossy().to_lowercase(),
        Some(c) => c == target.as_os_str(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{channel, Receiver};

    const WAIT: Duration = Duration::from_secs(5);
    const QUIET: Duration = Duration::from_millis(1200);

    fn setup(name: &str) -> (PathBuf, PathBuf, FileWatcher, Receiver<WatchEvent>) {
        let dir = std::env::temp_dir().join(format!("mdread-watch-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("doc.md");
        std::fs::write(&file, "one").unwrap();
        let (tx, rx) = channel();
        let w = FileWatcher::start(&file, move |e| {
            let _ = tx.send(e);
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(300)); // let the watch settle
        (dir, file, w, rx)
    }

    /// Waits until `want` arrives (other events are tolerated); fails on timeout.
    fn expect(rx: &Receiver<WatchEvent>, want: &WatchEvent) {
        let deadline = std::time::Instant::now() + WAIT;
        while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(ev) if &ev == want => return,
                Ok(_) => {}
                Err(_) => break,
            }
        }
        panic!("did not receive {want:?}");
    }

    #[test]
    fn modify_emits_changed() {
        let (_dir, file, _w, rx) = setup("modify");
        std::fs::write(&file, "two").unwrap();
        expect(&rx, &WatchEvent::Changed(display_path(&file)));
    }

    #[test]
    fn atomic_replace_emits_changed() {
        let (dir, file, _w, rx) = setup("atomic");
        let tmp = dir.join("doc.md.tmp");
        std::fs::write(&tmp, "three").unwrap();
        std::fs::rename(&tmp, &file).unwrap();
        expect(&rx, &WatchEvent::Changed(display_path(&file)));
    }

    #[test]
    fn delete_emits_removed() {
        let (_dir, file, _w, rx) = setup("delete");
        std::fs::remove_file(&file).unwrap();
        expect(&rx, &WatchEvent::Removed(display_path(&file)));
    }

    #[test]
    fn sibling_changes_are_ignored() {
        let (dir, _file, _w, rx) = setup("sibling");
        std::fs::write(dir.join("other.md"), "x").unwrap();
        std::fs::write(dir.join("other.md"), "y").unwrap();
        assert!(rx.recv_timeout(QUIET).is_err(), "unexpected event for a sibling file");
    }

    #[test]
    fn dropping_the_watcher_stops_events() {
        let (_dir, file, w, rx) = setup("drop");
        drop(w);
        std::fs::write(&file, "after drop").unwrap();
        assert!(rx.recv_timeout(QUIET).is_err());
    }
}
